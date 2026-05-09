// textDocument/references + textDocument/documentHighlight.
//
// Both providers need the same primitive: "find every occurrence of this
// identifier in the document". The two LSP responses just differ in how they
// wrap the spans:
//
//   • references         → Location[]              (cross-file in general; we
//                                                   only return same-file hits)
//   • documentHighlight  → DocumentHighlight[]     (with read/write hint)
//
// Scope handling for v1 is name-based: every identifier with a matching name
// is returned, regardless of which scope declared it. For .bac files this is
// usually what users want — names tend to be unique. A scope-aware filter
// (params/locals scoped to their owning function, class members file-wide)
// is a follow-up worth doing once shadowing shows up in real fixtures.

import { Location, DocumentHighlight, DocumentHighlightKind, Range } from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { findIdentifierAt, rangeFromSpan } from './text-utils';

export interface ReferenceContext {
  uri:    string;
  text:   string;
  ast:    ast.BacScriptAst;
  offset: number;
  /** Whether the user wants the declaration in the result list. */
  includeDeclaration?: boolean;
}

interface Hit {
  start: number;
  end:   number;
  kind:  'read' | 'write' | 'decl';
}

export function findReferences(ctx: ReferenceContext): Location[] {
  const ident = findIdentifierAt(ctx.text, ctx.offset);
  if (!ident) { return []; }
  const hits = collectHits(ctx.ast, ctx.text, ident.name);
  const include = ctx.includeDeclaration ?? true;
  return hits
    .filter(h => include || h.kind !== 'decl')
    .map(h => ({ uri: ctx.uri, range: spanToRange(ctx.text, h.start, h.end) }));
}

export function findDocumentHighlights(ctx: ReferenceContext): DocumentHighlight[] {
  const ident = findIdentifierAt(ctx.text, ctx.offset);
  if (!ident) { return []; }
  const hits = collectHits(ctx.ast, ctx.text, ident.name);
  return hits.map(h => ({
    range: spanToRange(ctx.text, h.start, h.end),
    kind:
      h.kind === 'write' ? DocumentHighlightKind.Write :
      h.kind === 'decl'  ? DocumentHighlightKind.Text  :
                           DocumentHighlightKind.Read,
  }));
}

// ─── Hit collector ────────────────────────────────────────────────────────

function collectHits(scriptAst: ast.BacScriptAst, text: string, name: string): Hit[] {
  const hits: Hit[] = [];

  // 1. Class declaration & members. We mark the declaration occurrence as
  //    `decl`. The decl name's exact offset isn't tracked in the AST, so we
  //    scan forward in the source from the member's location for the name —
  //    same heuristic used by other navigation providers.
  const cls = scriptAst.class;
  if (cls) {
    if (cls.name === name) { addNameHit(text, cls.location.offset, name, 'decl', hits); }

    for (const m of cls.members) {
      const memberName = (m.kind === 'construction' || m.kind === 'defaults' || m.kind === 'settings') ? undefined : m.name;
      if (memberName === name) {
        addNameHit(text, m.location.offset, name, 'decl', hits);
      }
      visitMember(m, name, text, hits);
    }
  }

  // 2. Struct fields — name on the field decl is `decl`; field types pull in
  //    type-ref hits the same way variable types do for class members.
  if (scriptAst.struct) {
    if (scriptAst.struct.name === name) {
      addNameHit(text, scriptAst.struct.location.offset, name, 'decl', hits);
    }
    for (const f of scriptAst.struct.fields) {
      if (f.name === name) { addNameHit(text, f.location.offset, name, 'decl', hits); }
      visitTypeRef(f.type, name, hits);
      if (f.initializer) { visitExpr(f.initializer, name, false, hits); }
    }
  }

  // 3. Asset body — every assignment LHS is a `write`; RHS is walked for
  //    name-bearing exprs.
  if (scriptAst.asset) {
    if (scriptAst.asset.name === name) {
      addNameHit(text, scriptAst.asset.location.offset, name, 'decl', hits);
    }
    if (scriptAst.asset.parentTypeName === name) {
      addNameHit(text, scriptAst.asset.location.offset, name, 'read', hits);
    }
    for (const a of scriptAst.asset.assignments) {
      if (a.name === name) { addNameHit(text, a.location.offset, name, 'write', hits); }
      visitExpr(a.value, name, false, hits);
    }
  }

  // 4. Table — table name decl + per-row name decls + per-row assignment
  //    LHS as writes.
  if (scriptAst.table) {
    if (scriptAst.table.name === name) {
      addNameHit(text, scriptAst.table.location.offset, name, 'decl', hits);
    }
    if (scriptAst.table.rowStructName === name) {
      addNameHit(text, scriptAst.table.location.offset, name, 'read', hits);
    }
    for (const r of scriptAst.table.rows) {
      if (r.name === name) { addNameHit(text, r.location.offset, name, 'decl', hits); }
      for (const a of r.assignments) {
        if (a.name === name) { addNameHit(text, a.location.offset, name, 'write', hits); }
        visitExpr(a.value, name, false, hits);
      }
    }
  }

  // Filter and dedupe by exact span (overlapping walks can revisit the same
  // identifier, e.g. a member name reached twice through different paths).
  // Sorted output makes the list stable.
  hits.sort((a, b) => a.start - b.start);
  const uniq: Hit[] = [];
  for (const h of hits) {
    const prev = uniq[uniq.length - 1];
    if (!prev || prev.start !== h.start || prev.end !== h.end) { uniq.push(h); }
  }
  return uniq;
}

function visitMember(m: ast.BacMember, name: string, text: string, out: Hit[]): void {
  for (const d of m.decorators) { visitDecorator(d, name, text, out); }
  switch (m.kind) {
    case 'variable':
      visitTypeRef(m.type, name, out);
      if (m.initializer) { visitExpr(m.initializer, name, false, out); }
      return;
    case 'component':
      visitTypeRef(m.type, name, out);
      if (m.attachParent === name) {
        // attach refers to a sibling component — record as a read.
        addNameHit(text, m.location.offset, name, 'read', out);
      }
      for (const def of m.defaults) {
        if (def.name === name) { addNameHit(text, def.location.offset, name, 'write', out); }
        visitExpr(def.value, name, false, out);
      }
      return;
    case 'function':
      for (const p of m.params) {
        if (p.name === name) { addNameHit(text, m.location.offset, name, 'decl', out); }
        visitTypeRef(p.type, name, out);
        if (p.default) { visitExpr(p.default, name, false, out); }
      }
      if (m.returnType) { visitTypeRef(m.returnType, name, out); }
      visitBlock(m.body, name, text, out);
      return;
    case 'event':
      for (const p of m.params) {
        if (p.name === name) { addNameHit(text, m.location.offset, name, 'decl', out); }
        visitTypeRef(p.type, name, out);
        if (p.default) { visitExpr(p.default, name, false, out); }
      }
      visitBlock(m.body, name, text, out);
      return;
    case 'construction':
      visitBlock(m.body, name, text, out);
      return;
  }
}

function visitDecorator(d: ast.BacDecorator, name: string, _text: string, out: Hit[]): void {
  // Decorator names like `@editable` aren't user identifiers — skip the head.
  for (const a of d.args) { visitExpr(a.value, name, false, out); }
}

function visitTypeRef(t: ast.BacTypeRef, name: string, out: Hit[]): void {
  if (t.baseName === name) {
    out.push({ start: t.location.offset, end: t.location.offset + name.length, kind: 'read' });
  }
  for (const arg of t.genericArgs) { visitTypeRef(arg, name, out); }
}

function visitBlock(b: ast.BacBlockStmt, name: string, text: string, out: Hit[]): void {
  for (const s of b.statements) { visitStmt(s, name, text, out); }
}

function visitStmt(s: ast.BacStmt, name: string, text: string, out: Hit[]): void {
  switch (s.kind) {
    case 'block':    visitBlock(s, name, text, out); return;
    case 'expr':     visitExpr(s.expr, name, false, out); return;
    case 'var_decl': {
      // var/let-decl carries no explicit name token offset — scan forward.
      if (s.name === name) { addNameHit(text, s.location.offset, name, 'decl', out); }
      if (s.type)         { visitTypeRef(s.type, name, out); }
      if (s.initializer)  { visitExpr(s.initializer, name, false, out); }
      return;
    }
    case 'if':
      if (s.letName === name) { addNameHit(text, s.location.offset, name, 'decl', out); }
      visitExpr(s.condition, name, false, out);
      visitBlock(s.then, name, text, out);
      if (s.else) { visitStmt(s.else, name, text, out); }
      return;
    case 'for':
      if (s.bindingName === name) { addNameHit(text, s.location.offset, name, 'decl', out); }
      if (s.bindingType) { visitTypeRef(s.bindingType, name, out); }
      visitExpr(s.iterable, name, false, out);
      visitBlock(s.body, name, text, out);
      return;
    case 'while':
      visitExpr(s.condition, name, false, out);
      visitBlock(s.body, name, text, out);
      return;
    case 'return':
      if (s.value) { visitExpr(s.value, name, false, out); }
      return;
    case 'assign':
      visitExpr(s.target, name, true, out);   // LHS is a write
      visitExpr(s.value,  name, false, out);
      return;
    default: return;
  }
}

function visitExpr(e: ast.BacExpr, name: string, asWrite: boolean, out: Hit[]): void {
  switch (e.kind) {
    case 'ident':
      if (e.name === name) {
        out.push({
          start: e.location.offset,
          end:   e.location.offset + name.length,
          kind:  asWrite ? 'write' : 'read',
        });
      }
      return;
    case 'member_access':
      visitExpr(e.target, name, false, out);
      // The member name itself may also be the searched name — a runtime
      // reference, but reporting it keeps "all occurrences" honest.
      if (e.memberName === name) {
        // No exact location for the member name; skip to avoid bogus ranges.
      }
      return;
    case 'index':
      visitExpr(e.target, name, false, out);
      visitExpr(e.index,  name, false, out);
      return;
    case 'call':
      visitExpr(e.callee, name, false, out);
      for (const a of e.args) { visitExpr(a.value, name, false, out); }
      return;
    case 'generic_call':
      visitExpr(e.callee, name, false, out);
      for (const t of e.typeArgs) { visitTypeRef(t, name, out); }
      for (const a of e.args)     { visitExpr(a.value, name, false, out); }
      return;
    case 'binary':
      visitExpr(e.left,  name, false, out);
      visitExpr(e.right, name, false, out);
      return;
    case 'unary':
      visitExpr(e.operand, name, false, out);
      return;
    case 'cast':
      visitExpr(e.source, name, false, out);
      visitTypeRef(e.targetType, name, out);
      return;
    case 'default':
      visitTypeRef(e.typeArg, name, out);
      return;
    case 'await':
      visitExpr(e.inner, name, false, out);
      return;
    default:
      return;
  }
}

// ─── Hit-to-LSP conversion ─────────────────────────────────────────────────

function addNameHit(text: string, fromOffset: number, name: string, kind: Hit['kind'], out: Hit[]): void {
  // Scan forward in the source for the name token; bail if not found within
  // ~300 chars (would only happen on very gnarly decl preludes — the heuristic
  // is the same one symbol/definition use).
  const idx = text.indexOf(name, fromOffset);
  if (idx < 0 || idx - fromOffset > 300) { return; }
  out.push({ start: idx, end: idx + name.length, kind });
}

function spanToRange(text: string, start: number, end: number): Range {
  // For zero-length spans (e.g. var_decl decl markers we couldn't precisely
  // resolve), fall back to a 1-char range so VS Code still highlights it.
  const realEnd = end > start ? end : start + 1;
  const r = rangeFromSpan(text, start, realEnd);
  return { start: { line: r.startLine, character: r.startColumn }, end: { line: r.endLine, character: r.endColumn } };
}
