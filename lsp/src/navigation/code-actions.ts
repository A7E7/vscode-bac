// textDocument/codeAction — turns BAC diagnostic `fixes` into clickable
// VS Code quick-fixes (the lightbulb menu).
//
// Diagnostics carry a `fixes: string[]` field formatted by the validators
// as one of two patterns:
//
//   "replace `X` with `Y`"          → in-place text replace
//   "add `X` before `Y`"            → insert X on a new line preceding Y
//
// where X / Y are literal substrings of the document near the diagnostic
// location. We parse each pattern, locate the anchor in the diagnostic's
// line window, and build a `WorkspaceEdit`.
//
// Why publish the fixes via `Diagnostic.data` rather than re-running the
// validators here: the validators only emit fixes when they have full
// context (e.g. a known nearest-neighbor for a typo, or the class name
// for an "add before" insertion). Re-running would lose that context for
// fixes computed from caches we don't keep.

import {
  CodeAction, CodeActionKind, CodeActionParams,
  Diagnostic, TextEdit, WorkspaceEdit, Range,
} from 'vscode-languageserver/node';

/** Shape we stuff into `Diagnostic.data` so we can resurrect the fixes here. */
export interface BacDiagnosticData {
  hint?:  string;
  fixes?: string[];
}

export interface CodeActionContext {
  uri:  string;
  text: string;
  /** The diagnostics the client thinks are in the requested range. */
  diagnostics: Diagnostic[];
}

export function buildCodeActions(ctx: CodeActionContext): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const diag of ctx.diagnostics) {
    const data = (diag.data as BacDiagnosticData | undefined) ?? {};
    if (!data.fixes) { continue; }
    for (const fix of data.fixes) {
      const action =
        replaceFix(ctx.uri, ctx.text, diag, fix) ??
        insertBeforeFix(ctx.uri, ctx.text, diag, fix);
      if (action) { actions.push(action); }
    }
  }
  return actions;
}

// "replace `X` with `Y`"  →  WorkspaceEdit replacing the first occurrence of
// X on the same line (or the next few, for decorator-on-previous-line decls).
const REPLACE_RE = /^replace\s+`([^`]+)`\s+with\s+`([^`]*)`\s*$/i;

function replaceFix(
  uri: string, text: string, diag: Diagnostic, fix: string,
): CodeAction | undefined {
  const m = REPLACE_RE.exec(fix.trim());
  if (!m) { return undefined; }
  const find    = m[1];
  const replace = m[2];

  const startOff = findInWindow(text, diag.range.start.line, find);
  if (startOff < 0) { return undefined; }
  const endOff = startOff + find.length;
  const edit: TextEdit = {
    range: { start: positionAt(text, startOff), end: positionAt(text, endOff) },
    newText: replace,
  };
  return makeAction(uri, fix, diag, [edit]);
}

// "add `X` before `Y`"  →  insert X on a new line above the line that holds
// Y, matching that line's leading whitespace so indentation stays sane.
// Used by BAC2240 (`add @replicated_default(replicates=true) before class X`).
const INSERT_BEFORE_RE = /^add\s+`([^`]+)`\s+before\s+`([^`]+)`\s*$/i;

function insertBeforeFix(
  uri: string, text: string, diag: Diagnostic, fix: string,
): CodeAction | undefined {
  const m = INSERT_BEFORE_RE.exec(fix.trim());
  if (!m) { return undefined; }
  const insert = m[1];
  const anchor = m[2];

  const anchorOff = findInWindow(text, diag.range.start.line, anchor);
  if (anchorOff < 0) { return undefined; }

  // Walk back to the start of the line containing `anchor` so the inserted
  // text gets its own line above it with matching indentation.
  let lineStart = anchorOff;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 0x0A) { lineStart--; }
  let indentEnd = lineStart;
  while (indentEnd < text.length && (text.charCodeAt(indentEnd) === 0x20 || text.charCodeAt(indentEnd) === 0x09)) {
    indentEnd++;
  }
  const indent = text.slice(lineStart, indentEnd);

  const insertPos = positionAt(text, lineStart);
  const edit: TextEdit = {
    range: { start: insertPos, end: insertPos },
    newText: indent + insert + '\n',
  };
  return makeAction(uri, fix, diag, [edit]);
}

function makeAction(
  uri: string, title: string, diag: Diagnostic, edits: TextEdit[],
): CodeAction {
  const wsEdit: WorkspaceEdit = { changes: { [uri]: edits } };
  return {
    title,
    kind:        CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit:        wsEdit,
    isPreferred: true,
  };
}

// Find `needle` near the diagnostic line. We search a window that extends
// a few lines BEFORE and AFTER the diagnostic — anchors can sit above
// (e.g. `class X` for a BAC2240 fired on a `@replicated` decorator) or
// below (e.g. `attach Reot` on the same component-decl line). If multiple
// occurrences exist within the window, prefer the one closest to the
// diagnostic line.
function findInWindow(text: string, line0: number, needle: string): number {
  const startLine = Math.max(0, line0 - 4);
  const endLine   = line0 + 4;
  const start = lineOffset(text, startLine);
  const end   = lineOffset(text, endLine);
  const slice = text.slice(start, end);

  // Pick the occurrence closest to (line0 - startLine), the diagnostic's
  // position within the window. Indices are byte offsets in `slice`; we
  // approximate "closeness" by distance from the diagnostic's line offset.
  const diagOffsetInSlice = lineOffset(text, line0) - start;
  let bestLocal = -1;
  let bestDist  = Number.POSITIVE_INFINITY;
  let from = 0;
  while (from <= slice.length) {
    const idx = slice.indexOf(needle, from);
    if (idx < 0) { break; }
    const dist = Math.abs(idx - diagOffsetInSlice);
    if (dist < bestDist) { bestDist = dist; bestLocal = idx; }
    from = idx + 1;
  }
  return bestLocal < 0 ? -1 : start + bestLocal;
}

// ─── Position helpers ─────────────────────────────────────────────────────

function lineOffset(text: string, lineZero: number): number {
  if (lineZero <= 0) { return 0; }
  let offset = 0, line = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0A) {
      line++;
      if (line === lineZero) { return i + 1; }
    }
  }
  return text.length;
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0A) { line++; col = 0; } else { col++; }
  }
  return { line, character: col };
}
