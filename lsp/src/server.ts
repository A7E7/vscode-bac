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
import { tokenize } from './script/lexer';
import { parse } from './script/parser';
import { BacDiagnostics, BacDiagnostic } from './script/diagnostics';
import { runContractCheck } from './validate/contract-check';
import { runReferenceCheck } from './validate/reference-check';
import { runTypeCheck } from './validate/type-check';

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

// JSON wire shape produced by the `bac.lint` UE exec command. Field names
// are flat strings (line/column) — different from the TS-internal
// BacDiagnostic which uses a nested BacSourceLocation. Renamed `_LintWire`
// so the import from script/diagnostics doesn't collide.
interface BacDiagnostic_LintWire {
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
  diagnostics:  BacDiagnostic_LintWire[];
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
//
// Two diagnostic streams per document, merged into one publishDiagnostics
// payload:
//
//   1. AST-only TS passes (lex + parse + contract/reference/type checks) —
//      run on every open / change. Sub-millisecond. No UE dependency.
//   2. Engine-coupled `bac.lint` UE roundtrip — runs on save only. Slow
//      (~5s editor startup) but the only path that can validate
//      identifier resolution against parent UClass + UFUNCTION reflection.
//
// Diagnostics from (1) are debounced (50ms) so rapid keystrokes don't ship
// stale output. Diagnostics from (2) are coalesced — one in-flight lint per
// document, additional saves drop until the current run finishes.

interface DocState {
  astDiagnostics:    Diagnostic[];      // from TS passes (didChange)
  engineDiagnostics: Diagnostic[];      // from bac.lint   (didSave)
  astDebounce?:      NodeJS.Timeout;
  engineInflight?:   Promise<void>;
}

function startLspServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents  = new TextDocuments(TextDocument);
  const states     = new Map<string, DocState>();
  const stateOf    = (uri: string): DocState => {
    let s = states.get(uri);
    if (!s) { s = { astDiagnostics: [], engineDiagnostics: [] }; states.set(uri, s); }
    return s;
  };

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
    for (const doc of documents.all()) {
      runAstPasses(connection, stateOf(doc.uri), doc);
      void runEngineLint(connection, stateOf(doc.uri), doc);
    }
  });

  documents.onDidOpen(async (e) => {
    const s = stateOf(e.document.uri);
    runAstPasses(connection, s, e.document);
    // Skip the engine pass on didOpen — first-open often coincides with
    // workspace startup; let the user save when they want full validation.
    publish(connection, e.document.uri, s);
  });

  documents.onDidChangeContent((e) => {
    const s = stateOf(e.document.uri);
    if (s.astDebounce) { clearTimeout(s.astDebounce); }
    s.astDebounce = setTimeout(() => {
      runAstPasses(connection, s, e.document);
      publish(connection, e.document.uri, s);
    }, 50);
  });

  documents.onDidSave(async (e) => {
    const s = stateOf(e.document.uri);
    runAstPasses(connection, s, e.document);
    publish(connection, e.document.uri, s);
    void runEngineLint(connection, s, e.document);
  });

  documents.onDidClose((e) => {
    const s = states.get(e.document.uri);
    if (s?.astDebounce) { clearTimeout(s.astDebounce); }
    states.delete(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  documents.listen(connection);
  connection.listen();
}

// ─── AST-only passes (didOpen / didChange) ─────────────────────────────────
function runAstPasses(
  connection: ReturnType<typeof createConnection>,
  state: DocState,
  doc: TextDocument,
): void {
  if (doc.languageId !== 'bac') { return; }
  const diags  = new BacDiagnostics();
  const tokens = tokenize(doc.getText(), diags);
  const ast    = parse(tokens, diags);
  runContractCheck(ast, diags);
  runReferenceCheck(ast, diags);
  runTypeCheck(ast, diags);
  state.astDiagnostics = diags.items.map(toLspDiagnosticFromBac);
}

function publish(
  connection: ReturnType<typeof createConnection>,
  uri: string,
  state: DocState,
): void {
  // Engine diagnostics override AST diagnostics by (code, line, column) — same
  // (code, location) coming from both pipelines means the engine pass already
  // confirmed it; no point in double-publishing.
  const seen = new Set<string>();
  const merged: Diagnostic[] = [];
  const keyOf = (d: Diagnostic): string =>
    `${d.code}|${d.range.start.line}|${d.range.start.character}`;
  for (const d of state.engineDiagnostics) { merged.push(d); seen.add(keyOf(d)); }
  for (const d of state.astDiagnostics)    { if (!seen.has(keyOf(d))) { merged.push(d); } }
  connection.sendDiagnostics({ uri, diagnostics: merged });
}

async function refreshSettings(connection: ReturnType<typeof createConnection>): Promise<void> {
  try {
    const config = await connection.workspace.getConfiguration({ section: 'bac' }) as Partial<BacSettings>;
    settings = { ...DEFAULTS, ...config };
  } catch {
    settings = { ...DEFAULTS };
  }
}

async function runEngineLint(
  connection: ReturnType<typeof createConnection>,
  state: DocState,
  doc: TextDocument,
): Promise<void> {
  if (!settings.enable)              { return; }
  if (doc.languageId !== 'bac')      { return; }
  const fsPath = URI.parse(doc.uri).fsPath;
  if (!fsPath || !fsPath.endsWith('.bac')) { return; }
  if (state.engineInflight)          { return; }   // coalesce
  if (!settings.projectPath) {
    connection.console.warn(
      "bac: 'bac.projectPath' is not configured — set it to the .uproject of a project that loads the BlueprintAsCode plugin. " +
      "AST-only diagnostics still work; engine-coupled checks are disabled.",
    );
    state.engineDiagnostics = [];
    publish(connection, doc.uri, state);
    return;
  }

  state.engineInflight = (async (): Promise<void> => {
    let result: BacLintResult;
    try {
      result = await invokeCommandlet(fsPath);
    } catch (err) {
      connection.console.error(`bac.lint failed for ${fsPath}: ${(err as Error).message}`);
      state.engineDiagnostics = [{
        severity: DiagnosticSeverity.Information,
        message:  `bac.lint did not complete: ${(err as Error).message}`,
        range:    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        source:   'bac',
      }];
      publish(connection, doc.uri, state);
      return;
    }
    state.engineDiagnostics = (result.diagnostics ?? []).map(toLspDiagnostic);
    publish(connection, doc.uri, state);
  })().finally(() => { state.engineInflight = undefined; });
  await state.engineInflight;
}

// AST-pass diagnostics arrive in the TS-internal `BacDiagnostic` shape; convert
// to LSP using the same point→1-char-range trick as the engine path.
function toLspDiagnosticFromBac(d: BacDiagnostic): Diagnostic {
  const startLine = Math.max(0, d.location.line - 1);
  const startCol  = Math.max(0, d.location.column - 1);
  const sev =
    d.severity === 'error'   ? DiagnosticSeverity.Error :
    d.severity === 'warning' ? DiagnosticSeverity.Warning :
                               DiagnosticSeverity.Information;
  const tail = [d.hint, ...(d.fixes ?? []).map((f) => `fix: ${f}`)].filter(Boolean).join('\n');
  const related: DiagnosticRelatedInformation[] | undefined =
    d.notes?.length
      ? d.notes.map((n) => ({
          location: {
            uri: '',
            range: {
              start: { line: Math.max(0, n.location.line - 1), character: Math.max(0, n.location.column - 1) },
              end:   { line: Math.max(0, n.location.line - 1), character: Math.max(0, n.location.column - 1) + 1 },
            },
          },
          message: n.message,
        }))
      : undefined;
  return {
    severity: sev,
    range:    {
      start: { line: startLine, character: startCol },
      end:   { line: startLine, character: startCol + 1 },
    },
    code:     d.code,
    message:  tail ? `${d.message}\n${tail}` : d.message,
    source:   'bac',
    relatedInformation: related,
  };
}

function toLspDiagnostic(d: BacDiagnostic_LintWire): Diagnostic {
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
