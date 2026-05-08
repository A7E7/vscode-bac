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
  CompletionItem, CompletionParams,
  Diagnostic, DiagnosticSeverity, DiagnosticRelatedInformation,
  DidChangeConfigurationNotification, InitializeParams, InitializeResult,
  TextDocumentSyncKind,
  Hover, HoverParams, Definition, DefinitionParams,
  DocumentSymbol, DocumentSymbolParams,
  Location, ReferenceParams,
  DocumentHighlight, DocumentHighlightParams,
  SignatureHelp, SignatureHelpParams,
  CodeAction, CodeActionParams, CodeActionKind,
  TextEdit, DocumentFormattingParams, DocumentRangeFormattingParams, Range,
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
import { analyzeCursor, findScopeAt, buildCompletionItemsAsync } from './completion/complete';
import { BacEngineProxy } from './completion/engine-proxy';
import { buildDocumentSymbols } from './navigation/symbols';
import { findDefinition } from './navigation/definition';
import { buildHover } from './navigation/hover';
import { findReferences, findDocumentHighlights } from './navigation/references';
import { buildSignatureHelp } from './navigation/signature';
import { buildCodeActions } from './navigation/code-actions';
import { formatBacText } from './format/format';

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

// Workspace folder roots captured at `initialize` time. Used to auto-detect a
// `.uproject` when the user hasn't set `bac.projectPath` explicitly.
let workspaceRoots: string[] = [];

// Last auto-detected `.uproject` path we logged about — guards against
// spamming the channel on every config refresh.
let lastAutoDetected: string | undefined;

// Engine proxy: connects to the running editor's completion server when the
// project path is known. Module-level so completion handlers can reach it.
let engineProxy:        BacEngineProxy | undefined;
let engineProxyForPath: string | undefined;  // projectDir the current proxy targets

// ─── Entry point ────────────────────────────────────────────────────────────
const formatIdx       = process.argv.indexOf('--format');
const onceNoEngineIdx = process.argv.indexOf('--once-no-engine');
const onceArgIdx      = process.argv.indexOf('--once');
if (formatIdx >= 0) {
  const filePath = process.argv[formatIdx + 1];
  if (!filePath) {
    process.stderr.write('usage: bac-language-server --format <file.bac>\n');
    process.exit(2);
  }
  runFormat(filePath).catch((err) => {
    process.stderr.write(`bac format failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
} else if (onceNoEngineIdx >= 0) {
  const filePath = process.argv[onceNoEngineIdx + 1];
  if (!filePath) {
    process.stderr.write('usage: bac-language-server --once-no-engine <file.bac>\n');
    process.exit(2);
  }
  runOnceNoEngine(filePath).catch((err) => {
    process.stderr.write(`bac AST pass failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
} else if (onceArgIdx >= 0) {
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

// ─── CLI mode (formatter, no UE) ────────────────────────────────────────────
//
// Reads a `.bac` file, prints the formatted output to stdout, exits 0 on
// clean format. Use it in pre-commit hooks, AI agent loops, and CI.
async function runFormat(filePath: string): Promise<void> {
  let source: string;
  try {
    source = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`bac: cannot read ${filePath}: ${(err as Error).message}\n`);
    process.exit(2);
  }
  process.stdout.write(formatBacText(source));
  process.exit(0);
}

// ─── CLI mode (engine-coupled, full bac.lint UE roundtrip) ──────────────────
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

// ─── CLI mode (AST-only, no UE) ────────────────────────────────────────────
//
// Same JSON shape as `--once` but runs only the TS validator passes. Use this
// in CI / AI agent loops that don't have a UE install or want sub-100ms
// turnaround. It catches everything in BAC1xxx (parser), BAC22xx (reference),
// and BAC23xx (type/contract) — i.e. ~80% of the diagnostics surface, missing
// only the engine-coupled identifier checks (BAC2310/2311 from BacIdentifierCheck).
async function runOnceNoEngine(filePath: string): Promise<void> {
  let source: string;
  try {
    source = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`bac: cannot read ${filePath}: ${(err as Error).message}\n`);
    process.exit(2);
  }
  const diags  = new BacDiagnostics();
  const tokens = tokenize(source, diags);
  const ast    = parse(tokens, diags);
  runContractCheck(ast, diags);
  runReferenceCheck(ast, diags);
  runTypeCheck(ast, diags);
  const out = {
    ok:           !diags.items.some((d) => d.severity === 'error'),
    mode:         'ast-only',
    diagnostics:  diags.items.map((d) => ({
      severity: d.severity,
      code:     d.code,
      message:  d.message,
      line:     d.location.line,
      column:   d.location.column,
      offset:   d.location.offset,
      hint:     d.hint,
      fixes:    d.fixes,
    })),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.ok ? 0 : 1);
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

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    workspaceRoots = collectRootsFromInitParams(params);
    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change:    TextDocumentSyncKind.Incremental,
          save:      { includeText: false },
        },
        completionProvider: {
          // `.` opens member-access completion. Identifier characters are
          // handled implicitly — the client invokes completion on each
          // letter and we filter by prefix in `buildCompletionItems`.
          triggerCharacters: ['.'],
          resolveProvider:   false,
        },
        hoverProvider:             true,
        definitionProvider:        true,
        documentSymbolProvider:    true,
        referencesProvider:        true,
        documentHighlightProvider: true,
        signatureHelpProvider: {
          // `(` opens, `,` advances active parameter; `)` doesn't trigger
          // because the help should disappear when the call closes.
          triggerCharacters:   ['(', ','],
          retriggerCharacters: [','],
        },
        codeActionProvider: {
          codeActionKinds: [CodeActionKind.QuickFix],
          resolveProvider: false,
        },
        documentFormattingProvider:      true,
        documentRangeFormattingProvider: true,
      },
    };
  });

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

  // textDocument/completion — TS-side passes always run (cheap); the engine
  // proxy is consulted for member-access on a known type when an editor is
  // attached. Re-parses the doc on each request so we work against live text.
  connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[]> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    const ctx    = analyzeCursor(text, offset);
    const scriptAst = parseDoc(text);
    const scope  = findScopeAt(scriptAst, offset);
    return buildCompletionItemsAsync(ctx, scope, engineProxy);
  });

  // textDocument/hover — markdown popup with type info / decorators / engine
  // tooltips. Uses the same engine proxy as completion for inherited members.
  connection.onHover(async (params: HoverParams): Promise<Hover | undefined> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return undefined; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    return buildHover({ text, ast: parseDoc(text), offset, proxy: engineProxy });
  });

  // textDocument/definition — F12 / Cmd-click. TS-only resolver: jumps to
  // params, locals, and class members declared in the same .bac file.
  connection.onDefinition((params: DefinitionParams): Definition | undefined => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return undefined; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    return findDefinition({ uri: doc.uri, text, ast: parseDoc(text), offset });
  });

  // textDocument/documentSymbol — outline view + breadcrumb.
  connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    const text = doc.getText();
    return buildDocumentSymbols(parseDoc(text), text);
  });

  // textDocument/references — Shift+F12. Same-file only for now (no
  // multi-document index). Name-based; doesn't yet honor scope shadowing.
  connection.onReferences((params: ReferenceParams): Location[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    return findReferences({
      uri:    doc.uri,
      text,
      ast:    parseDoc(text),
      offset,
      includeDeclaration: params.context?.includeDeclaration ?? true,
    });
  });

  // textDocument/documentHighlight — soft highlight of all occurrences when
  // the cursor sits on an identifier (read/write/decl distinction kept).
  connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    return findDocumentHighlights({ uri: doc.uri, text, ast: parseDoc(text), offset });
  });

  // textDocument/signatureHelp — parameter hints inside an open call.
  // Triggers on `(` and `,`. Engine path mirrors hover/completion: resolve
  // receiver type, ask the proxy, render with the active param highlighted.
  connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | undefined> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return undefined; }
    const text   = doc.getText();
    const offset = doc.offsetAt(params.position);
    return buildSignatureHelp({ text, ast: parseDoc(text), offset, proxy: engineProxy });
  });

  // textDocument/codeAction — surface diagnostic `fixes` as quick-fixes.
  // The fixes were stuffed into `Diagnostic.data` at publish time so we can
  // resurrect them here without re-running the validator.
  connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    const text = doc.getText();
    return buildCodeActions({
      uri:         doc.uri,
      text,
      diagnostics: params.context.diagnostics,
    });
  });

  // textDocument/formatting — opinionated format-document. We always
  // replace the whole document with the formatted text; partial-range
  // formatting falls back to the same (formatting just a fragment isn't
  // meaningful for a language whose layout is canonical).
  connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    return [whole(doc, formatBacText(doc.getText()))];
  });
  connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId !== 'bac') { return []; }
    return [whole(doc, formatBacText(doc.getText()))];
  });

  documents.listen(connection);
  connection.listen();
}

function whole(doc: TextDocument, formatted: string): TextEdit {
  const fullRange: Range = {
    start: { line: 0, character: 0 },
    end:   doc.positionAt(doc.getText().length),
  };
  return { range: fullRange, newText: formatted };
}

// Tokenize + parse helper used by the navigation handlers (hover, definition,
// document symbols). They don't need diagnostics — the AST itself is enough —
// but we still feed a transient `BacDiagnostics` because the lexer/parser
// signal recoverable errors through it.
function parseDoc(text: string): import('./script/ast').BacScriptAst {
  const diags  = new BacDiagnostics();
  const tokens = tokenize(text, diags);
  return parse(tokens, diags);
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
  // If the user hasn't set `bac.projectPath` (and the env var didn't fill it),
  // try to find a `.uproject` at the top level of any workspace folder. The
  // explicit setting and the env var both still win.
  if (!settings.projectPath && workspaceRoots.length > 0) {
    const found = await findUprojectInRoots(workspaceRoots, connection);
    if (found) {
      settings.projectPath = found;
      if (lastAutoDetected !== found) {
        connection.console.info(`bac: auto-detected project at ${found}`);
        lastAutoDetected = found;
      }
    }
  }
  ensureEngineProxy(connection);
}

function ensureEngineProxy(connection: ReturnType<typeof createConnection>): void {
  const projectDir = settings.projectPath ? path.dirname(settings.projectPath) : undefined;
  if (engineProxy && engineProxyForPath === projectDir) { return; }
  if (engineProxy) {
    engineProxy.dispose();
    engineProxy = undefined;
    engineProxyForPath = undefined;
  }
  if (!projectDir) { return; }
  engineProxy = new BacEngineProxy({
    projectDir,
    log: (level, msg) => {
      if (level === 'error')      { connection.console.error(msg); }
      else if (level === 'warn')  { connection.console.warn(msg);  }
      else                        { connection.console.info(msg);  }
    },
  });
  engineProxy.start();
  engineProxyForPath = projectDir;
}

function collectRootsFromInitParams(params: InitializeParams): string[] {
  const roots: string[] = [];
  if (params.workspaceFolders) {
    for (const f of params.workspaceFolders) {
      const p = URI.parse(f.uri).fsPath;
      if (p) { roots.push(p); }
    }
  }
  if (roots.length === 0 && params.rootUri) {
    const p = URI.parse(params.rootUri).fsPath;
    if (p) { roots.push(p); }
  }
  return roots;
}

async function findUprojectInRoots(
  roots: string[],
  connection: ReturnType<typeof createConnection>,
): Promise<string | undefined> {
  const matches: string[] = [];
  for (const root of roots) {
    try {
      const entries = await fsp.readdir(root);
      for (const e of entries) {
        if (e.endsWith('.uproject')) { matches.push(path.join(root, e)); }
      }
    } catch { /* unreadable root — ignore */ }
  }
  if (matches.length === 0) { return undefined; }
  if (matches.length > 1) {
    connection.console.warn(
      `bac: found ${matches.length} .uproject files in workspace ` +
      `(${matches.join(', ')}); using ${matches[0]}. ` +
      `Set 'bac.projectPath' explicitly to override.`,
    );
  }
  return matches[0];
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
    // Stash hint + fixes so the code-action handler can resurrect them
    // without re-running the validator. Shape: BacDiagnosticData.
    data:     d.hint || d.fixes ? { hint: d.hint, fixes: d.fixes } : undefined,
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
    // Same payload as the AST path so the code-action handler doesn't have
    // to know which pipeline produced the diagnostic.
    data:     d.hint || d.fixes ? { hint: d.hint, fixes: d.fixes } : undefined,
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
