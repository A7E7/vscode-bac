// textDocument/documentSymbol — populates the VS Code outline view & breadcrumb.
//
// We emit the script class as the root symbol with each member nested inside.
// Parameters and locals aren't surfaced (they'd noise up the outline; goto-def
// covers them). Without end-locations on AST nodes we estimate ranges from
// "member start" to "next member start" — same heuristic the completion
// provider uses for cursor containment.

import { DocumentSymbol, SymbolKind, Range } from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { rangeFromSpan } from './text-utils';

export function buildDocumentSymbols(scriptAst: ast.BacScriptAst, text: string): DocumentSymbol[] {
  if (!scriptAst.class) { return []; }
  const cls = scriptAst.class;

  const memberSymbols: DocumentSymbol[] = [];
  for (let i = 0; i < cls.members.length; i++) {
    const m = cls.members[i];
    const next = cls.members[i + 1];
    const range = memberRange(m, next, text);
    const sel   = memberSelectionRange(m, text);
    const sym   = symbolForMember(m, range, sel);
    if (sym) { memberSymbols.push(sym); }
  }

  // The class itself spans from its `class` keyword to end-of-file.
  const classStart = cls.location.offset;
  const classRange = lspRange(rangeFromSpan(text, classStart, text.length));
  const classSel   = lspRange(rangeFromSpan(text, classStart, classStart + cls.name.length + /*"class "*/ 6));

  return [{
    name:           cls.name,
    detail:         cls.parentTypeName ? `: ${cls.parentTypeName}` : undefined,
    kind:           SymbolKind.Class,
    range:          classRange,
    selectionRange: classSel,
    children:       memberSymbols,
  }];
}

function memberRange(m: ast.BacMember, next: ast.BacMember | undefined, text: string): Range {
  const start = m.location.offset;
  const end   = next ? next.location.offset : text.length;
  return lspRange(rangeFromSpan(text, start, end));
}

function memberSelectionRange(m: ast.BacMember, text: string): Range {
  // The "selection" range is what the breadcrumb highlights — the member name.
  // We don't have an exact name token offset, so we scan forward from the
  // member start for the name in the raw text. Falls back to a 1-char range
  // at the start if the scan misses (shouldn't happen on well-formed input).
  const memberName = nameOf(m);
  const start = m.location.offset;
  if (memberName) {
    const idx = text.indexOf(memberName, start);
    if (idx >= 0 && idx < start + 200) {
      return lspRange(rangeFromSpan(text, idx, idx + memberName.length));
    }
  }
  return lspRange(rangeFromSpan(text, start, start + 1));
}

function symbolForMember(m: ast.BacMember, range: Range, sel: Range): DocumentSymbol | undefined {
  switch (m.kind) {
    case 'variable':
      return { name: m.name, detail: `: ${formatType(m.type)}`,    kind: SymbolKind.Field,       range, selectionRange: sel };
    case 'component':
      return { name: m.name, detail: `: ${formatType(m.type)}`,    kind: SymbolKind.Field,       range, selectionRange: sel };
    case 'function':
      return { name: m.name, detail: formatFunctionDetail(m),       kind: SymbolKind.Function,    range, selectionRange: sel };
    case 'event':
      return { name: m.name, detail: formatEventDetail(m),          kind: SymbolKind.Event,       range, selectionRange: sel };
    case 'construction':
      return { name: '(construction)', detail: undefined,           kind: SymbolKind.Constructor, range, selectionRange: sel };
  }
}

function nameOf(m: ast.BacMember): string | undefined {
  switch (m.kind) {
    case 'construction': return undefined;
    default:             return m.name;
  }
}

function formatType(t: ast.BacTypeRef): string {
  let s = t.baseName;
  if (t.genericArgs.length > 0) {
    s += '<' + t.genericArgs.map(formatType).join(', ') + '>';
  }
  for (let i = 0; i < t.arrayDepth; i++) { s += '[]'; }
  return s;
}
function formatFunctionDetail(f: ast.BacFunctionDecl): string {
  const params = f.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
  const ret    = f.returnType ? `: ${formatType(f.returnType)}` : '';
  const tag    = f.isPure ? ' [pure]' : '';
  return `(${params})${ret}${tag}`;
}
function formatEventDetail(e: ast.BacEventDecl): string {
  const params = e.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
  return `(${params})`;
}

interface SimpleRange { startLine: number; startColumn: number; endLine: number; endColumn: number }
function lspRange(r: SimpleRange): Range {
  return { start: { line: r.startLine, character: r.startColumn }, end: { line: r.endLine, character: r.endColumn } };
}
