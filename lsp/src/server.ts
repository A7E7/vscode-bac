#!/usr/bin/env node
// BAC language server.
//
// Two modes, same code:
//   1. LSP mode (default) — listens on stdio, lints `.bac` documents on
//      didOpen / didSave, pushes diagnostics back as publishDiagnostics.
//   2. CLI mode (`--once <file>`) — runs one lint pass and prints the JSON to
//      stdout. Same code path, useful for CI / AI agents that just want a
//      structured diagnostic blob for a single file.
//
// Both modes invoke the BlueprintAsCode plugin's `bac.lint` exec command in a
// freshly-spawned UnrealEditor-Cmd process, then read the JSON file the
// commandlet wrote. UE editor startup is ~5s, so the LSP only lints on save.

import {
  createConnection, ProposedFeatures, TextDocuments,
  Diagnostic, DiagnosticSeverity, DiagnosticRelatedInformation,
  DidChangeConfigurationNotification, InitializeParams, InitializeResult,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

interface BacSettings {
  unrealEditorPath: string;
  projectPath:      string;
  enable:           boolean;
  lintTimeoutMs:    number;
}

const DEFAULTS: BacSettings = {
  unrealEditorPath: process.env.BAC_UE_CMD       ?? '/Users/Shared/Epic Games/UE_5.7/Engine/Binaries/Mac/UnrealEditor-Cmd',
  projectPath:      process.env.BAC_PROJECT_PATH ?? '',
  enable:           true,
  lintTimeoutMs:    60_000,
};

interface BacDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code:    string;
  message: string;
  line:    number;
  column:  number;
  offset:  number;
  notes?:  Array<{ message: string; line: number; column: number; offset: number }>;
  hint?:   string;
  fixes?:  string[];
}

interface BacLintResult {
  ok:           boolean;
  diagnostics:  BacDiagnostic[];
}

let settings: BacSettings = { ...DEFAULTS };

// ─── Entry point ────────────────────────────────────────────────────────────
const onceArgIdx = process.argv.indexOf('--once');
if (onceArgIdx >= 0) {
  const filePath = process.argv[onceArgIdx + 1];
  if (!filePath) {
    process.stderr.write('usage: bac-language-server --once <file.bac>\n');
    process.exit(2);
  }
  runOnce(filePath).catch((err) => {
    process.stderr.write(`bac.lint failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
} else {
  startLspServer();
}

// ─── CLI mode ───────────────────────────────────────────────────────────────
async function runOnce(filePath: string): Promise<void> {
  if (!settings.projectPath) {
    process.stderr.write(
      "BAC_PROJECT_PATH env var is not set — point it at the .uproject that loads the BlueprintAsCode plugin.\n",
    );
    process.exit(2);
  }
  const result = await invokeCommandlet(filePath);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ─── LSP mode ───────────────────────────────────────────────────────────────
function startLspServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents  = new TextDocuments(TextDocument);
  // One in-flight lint per document. UE editor startup is expensive — stacking
  // concurrent runs against the same project would just contend.
  const inflight   = new Map<string, Promise<void>>();

  connection.onInitialize((_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change:    TextDocumentSyncKind.Incremental,
        save:      { includeText: false },
      },
    },
  }));

  connection.onInitialized(async () => {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
    await refreshSettings(connection);
  });

  connection.onDidChangeConfiguration(async () => {
    await refreshSettings(connection);
    for (const doc of documents.all()) { void runLint(connection, inflight, doc); }
  });

  documents.onDidOpen(async (e) => { void runLint(connection, inflight, e.document); });
  documents.onDidSave(async (e) => { void runLint(connection, inflight, e.document); });

  documents.listen(connection);
  connection.listen();
}

async function refreshSettings(connection: ReturnType<typeof createConnection>): Promise<void> {
  try {
    const config = await connection.workspace.getConfiguration({ section: 'bac' }) as Partial<BacSettings>;
    settings = { ...DEFAULTS, ...config };
  } catch {
    settings = { ...DEFAULTS };
  }
}

async function runLint(
  connection: ReturnType<typeof createConnection>,
  inflight: Map<string, Promise<void>>,
  doc: TextDocument,
): Promise<void> {
  if (!settings.enable)              { return; }
  if (doc.languageId !== 'bac')      { return; }

  const fsPath = URI.parse(doc.uri).fsPath;
  if (!fsPath || !fsPath.endsWith('.bac')) { return; }
  if (inflight.has(doc.uri))         { return; }

  const job = doLint(connection, doc, fsPath).finally(() => {
    inflight.delete(doc.uri);
  });
  inflight.set(doc.uri, job);
  await job;
}

async function doLint(
  connection: ReturnType<typeof createConnection>,
  doc: TextDocument,
  fsPath: string,
): Promise<void> {
  if (!settings.projectPath) {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    connection.console.warn(
      "bac: 'bac.projectPath' is not configured — set it to the .uproject of a project that loads the BlueprintAsCode plugin.",
    );
    return;
  }

  let result: BacLintResult;
  try {
    result = await invokeCommandlet(fsPath);
  } catch (err) {
    connection.console.error(`bac.lint failed for ${fsPath}: ${(err as Error).message}`);
    connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: [{
        severity: DiagnosticSeverity.Information,
        message:  `bac.lint did not complete: ${(err as Error).message}`,
        range:    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        source:   'bac',
      }],
    });
    return;
  }

  connection.sendDiagnostics({
    uri: doc.uri,
    diagnostics: (result.diagnostics ?? []).map(toLspDiagnostic),
  });
}

function toLspDiagnostic(d: BacDiagnostic): Diagnostic {
  // BAC locations are 1-based; LSP positions are 0-based.
  // The validator gives us a single point; synthesize a 1-char range so the
  // squiggle is visible.
  const startLine = Math.max(0, d.line - 1);
  const startCol  = Math.max(0, d.column - 1);
  const range = {
    start: { line: startLine, character: startCol },
    end:   { line: startLine, character: startCol + 1 },
  };
  const sev =
    d.severity === 'error'   ? DiagnosticSeverity.Error :
    d.severity === 'warning' ? DiagnosticSeverity.Warning :
                               DiagnosticSeverity.Information;
  const related: DiagnosticRelatedInformation[] | undefined =
    d.notes?.length
      ? d.notes.map((n) => ({
          location: {
            uri: '',
            range: {
              start: { line: Math.max(0, n.line - 1), character: Math.max(0, n.column - 1) },
              end:   { line: Math.max(0, n.line - 1), character: Math.max(0, n.column - 1) + 1 },
            },
          },
          message: n.message,
        }))
      : undefined;
  const tail = [d.hint, ...(d.fixes ?? []).map((f) => `fix: ${f}`)].filter(Boolean).join('\n');
  return {
    severity: sev,
    range,
    code:     d.code,
    message:  tail ? `${d.message}\n${tail}` : d.message,
    source:   'bac',
    relatedInformation: related,
  };
}

// ─── Spawn UnrealEditor-Cmd to run `bac.lint` ───────────────────────────────
async function invokeCommandlet(inputPath: string): Promise<BacLintResult> {
  const outPath = path.join(
    os.tmpdir(),
    `bac-lint-${crypto.randomBytes(4).toString('hex')}.json`,
  );

  // ExecCmds uses `,` as the command separator (semicolons get glued to the
  // last arg by the parser). Spaces around the comma are required.
  const args = [
    settings.projectPath,
    `-ExecCmds=bac.lint ${inputPath} ${outPath} , Quit`,
    '-unattended',
    '-nopause',
    '-NullRHI',
    '-nosplash',
  ];

  const child = spawn(settings.unrealEditorPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), settings.lintTimeoutMs);

  const stderr: Buffer[] = [];
  child.stderr.on('data', (d) => stderr.push(d));
  // Drain stdout so the buffer doesn't fill and stall the child.
  child.stdout.on('data', () => { /* discarded — we read JSON from disk */ });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject);
  });
  clearTimeout(timer);

  let raw: string;
  try {
    raw = await fsp.readFile(outPath, 'utf8');
  } catch {
    throw new Error(
      `UnrealEditor-Cmd exited ${exitCode} but did not produce ${outPath}. ` +
      `stderr tail: ${Buffer.concat(stderr).toString('utf8').slice(-500)}`,
    );
  } finally {
    void fsp.rm(outPath, { force: true });
  }

  try {
    return JSON.parse(raw) as BacLintResult;
  } catch (err) {
    throw new Error(
      `bac.lint produced invalid JSON: ${(err as Error).message}\n${raw.slice(0, 500)}`,
    );
  }
}
