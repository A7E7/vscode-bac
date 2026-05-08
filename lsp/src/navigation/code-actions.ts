// textDocument/codeAction — turns BAC diagnostic `fixes` into clickable
// VS Code quick-fixes (the lightbulb menu).
//
// Diagnostics carry a `fixes: string[]` field formatted by the validators as
//
//   "replace `X` with `Y`"
//
// where X is a literal substring of the document near the diagnostic
// location. We parse the pattern, locate X in the line containing the
// diagnostic, and build a `WorkspaceEdit` that does the replacement. The
// hint (if any) is offered as an extra "info" code action so the user can
// at least read it from the menu.
//
// Why publish the fixes via `Diagnostic.data` rather than re-running the
// validators here: the validators only emit fixes when they have full
// context (e.g. a known nearest-neighbor for a typo). Re-running would lose
// that context for fixes computed from caches we don't keep.

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
    if (data.fixes) {
      for (const fix of data.fixes) {
        const action = quickFixFromString(ctx.uri, ctx.text, diag, fix);
        if (action) { actions.push(action); }
      }
    }
  }
  return actions;
}

// "replace `X` with `Y`"  →  WorkspaceEdit replacing the first occurrence of
// X on the same line (or the next 3 lines, to handle multi-line decls).
const REPLACE_RE = /^replace\s+`([^`]+)`\s+with\s+`([^`]*)`\s*$/i;

function quickFixFromString(
  uri: string, text: string, diag: Diagnostic, fix: string,
): CodeAction | undefined {
  const m = REPLACE_RE.exec(fix.trim());
  if (!m) { return undefined; }
  const find    = m[1];
  const replace = m[2];

  // Anchor the search at the diagnostic line. The validator emits fixes whose
  // `find` text sits on the diagnostic's line for almost every case; we widen
  // by a small window for decorator-on-previous-line declarations.
  const lineStart = lineOffset(text, diag.range.start.line);
  const windowEnd = lineOffset(text, diag.range.start.line + 4);
  const haystack  = text.slice(lineStart, windowEnd);
  const localIdx  = haystack.indexOf(find);
  if (localIdx < 0) { return undefined; }
  const startOff = lineStart + localIdx;
  const endOff   = startOff + find.length;
  const range: Range = { start: positionAt(text, startOff), end: positionAt(text, endOff) };
  const edit: TextEdit = { range, newText: replace };
  const wsEdit: WorkspaceEdit = { changes: { [uri]: [edit] } };

  return {
    title:       fix,
    kind:        CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit:        wsEdit,
    isPreferred: true,
  };
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
