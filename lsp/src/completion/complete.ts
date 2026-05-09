// Slice 1 — TS-only completion provider.
//
// What this slice handles (no engine reflection required):
//   • Top-level partial identifier: complete from class members + function/event
//     params + locals declared earlier in the same function body.
//   • `<Receiver>.<partial>` where Receiver is a script-declared class member
//     whose declared type is `this`/`super`/another script class. Engine types
//     (StaticMeshComponent, AActor, …) return nothing for now and will be filled
//     in by Slice 2 via the running editor.
//
// Cursor-context analysis is text-only (does not need a parse) — we look back
// from the cursor at characters and decide whether we're after a `.` or not.
// Symbol resolution uses the AST that the diagnostic pipeline already builds.
//
// Notes on robustness:
//   • The parser may have produced errors (e.g. trailing `Mesh.`); we still walk
//     whatever AST it returned and tolerate missing fields.
//   • We don't have end-locations on AST members, so "cursor is in function F"
//     is decided by `F.location.offset <= cursor < nextMember.location.offset`.

import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { BacEngineProxy, EngineTypeMembers, EngineStructMembers } from './engine-proxy';

// ─── Cursor context ─────────────────────────────────────────────────────────

export interface CursorContext {
  kind:      'top-level' | 'member-access';
  prefix:    string;       // partial identifier already typed; used to filter
  receiver?: string;       // for member-access: the bare identifier before the `.`
}

export function analyzeCursor(text: string, offset: number): CursorContext {
  // Eat the partial identifier directly to the left of the cursor.
  let i = Math.min(offset, text.length);
  const prefixEnd = i;
  while (i > 0 && isIdentChar(text.charCodeAt(i - 1))) { i--; }
  const prefix = text.slice(i, prefixEnd);

  // Skip whitespace between partial and `.`.
  let j = i;
  while (j > 0 && isWs(text.charCodeAt(j - 1))) { j--; }

  if (j > 0 && text.charCodeAt(j - 1) === DOT) {
    j--;
    while (j > 0 && isWs(text.charCodeAt(j - 1))) { j--; }
    const recvEnd = j;
    while (j > 0 && isIdentChar(text.charCodeAt(j - 1))) { j--; }
    const receiver = text.slice(j, recvEnd);
    if (receiver.length > 0) {
      return { kind: 'member-access', prefix, receiver };
    }
  }

  return { kind: 'top-level', prefix };
}

const DOT = 0x2E;
function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D;
}
function isIdentChar(c: number): boolean {
  // [A-Za-z0-9_]
  return (c >= 0x30 && c <= 0x39) ||
         (c >= 0x41 && c <= 0x5A) ||
         (c >= 0x61 && c <= 0x7A) ||
         c === 0x5F;
}

// ─── Scope resolution at cursor ─────────────────────────────────────────────

export interface ResolvedSymbol {
  name:        string;
  kind:        'param' | 'local' | 'var' | 'component' | 'function' | 'event' | 'class';
  /** Declared type's base name (e.g. "StaticMeshComponent"). For functions, the return type. */
  typeName?:   string;
  /** One-line summary shown next to the completion label. */
  detail?:     string;
}

export interface ScopeAt {
  classDecl?:        ast.BacClassDecl;
  containingMember?: ast.BacMember;
  /** Declared in the script class itself (vars, components, functions, events). */
  classMembers:      ResolvedSymbol[];
  /** Params and locals visible at the cursor, keyed by name (most-local wins). */
  locals:            Map<string, ResolvedSymbol>;
  /**
   * Cursor sits inside an `asset Foo : ParentClass { … }` body. The parent
   * class name is what the LSP hands to the engine proxy's `completeType` to
   * fetch the editable property surface for completion.
   */
  assetContext?:     { parentTypeName: string };
  /**
   * Cursor sits inside a `row "Name" { … }` body of a `table Foo : RowStruct`
   * declaration. The row-struct name resolves via `completeStruct`.
   */
  rowContext?:       { rowStructName: string };
}

export function findScopeAt(scriptAst: ast.BacScriptAst, cursorOffset: number): ScopeAt {
  const result: ScopeAt = {
    classDecl:    scriptAst.class,
    classMembers: [],
    locals:       new Map(),
  };

  // Asset top-level decl: cursor inside `asset Foo : Parent { … }` body
  // suggests editable properties of `Parent`. We don't have an end-location
  // on the decl, so the body bound is "rest of file" — that's safe because
  // a script can hold AT MOST ONE top-level asset/table/struct/class decl
  // (the parser rejects mixed top-levels). Header-line typing also lands
  // here, but the engine call only fires on a non-empty prefix at top-level
  // so the "I'm typing the parent class name" case stays cheap.
  if (scriptAst.asset && cursorOffset > scriptAst.asset.location.offset) {
    result.assetContext = { parentTypeName: scriptAst.asset.parentTypeName };
  }

  // Table row body: locate the row whose start offset is the latest one
  // at-or-before the cursor. Since rows don't carry end-locations, the
  // next row's offset (or the table's "rest of body") bounds it. Same
  // heuristic as `findContainingMember`.
  if (scriptAst.table && cursorOffset > scriptAst.table.location.offset) {
    let containingRow: ast.BacTableRow | undefined;
    let nextRowOffset = Number.POSITIVE_INFINITY;
    for (let i = 0; i < scriptAst.table.rows.length; i++) {
      const r = scriptAst.table.rows[i];
      if (r.location.offset <= cursorOffset) { containingRow = r; }
      if (r.location.offset > cursorOffset && containingRow) {
        nextRowOffset = r.location.offset; break;
      }
    }
    if (containingRow && cursorOffset < nextRowOffset) {
      result.rowContext = { rowStructName: scriptAst.table.rowStructName };
    }
  }

  if (!scriptAst.class) { return result; }

  // Class-level symbols are always visible.
  for (const m of scriptAst.class.members) {
    const sym = symbolFromMember(m);
    if (sym) { result.classMembers.push(sym); }
  }

  // Find the function/event/construction that owns the cursor.
  result.containingMember = findContainingMember(scriptAst.class, cursorOffset);
  if (!result.containingMember) { return result; }

  // Collect params + locals declared before the cursor.
  collectParamsAndLocals(result.containingMember, cursorOffset, result.locals);

  return result;
}

function symbolFromMember(m: ast.BacMember): ResolvedSymbol | undefined {
  switch (m.kind) {
    case 'variable':  return { name: m.name, kind: 'var',       typeName: typeName(m.type), detail: `: ${formatType(m.type)}` };
    case 'component': return { name: m.name, kind: 'component', typeName: typeName(m.type), detail: `: ${formatType(m.type)}` };
    case 'function':  return { name: m.name, kind: 'function',  typeName: m.returnType ? typeName(m.returnType) : undefined,
                               detail: formatFunctionSignature(m) };
    case 'event':     return { name: m.name, kind: 'event',     detail: formatEventSignature(m) };
    case 'construction': return undefined;
  }
}

function findContainingMember(cls: ast.BacClassDecl, cursorOffset: number): ast.BacMember | undefined {
  // Members are emitted in source order. Find the last one starting at or
  // before the cursor; the next member's offset (or +∞) bounds the body.
  // This is a heuristic since we lack end-locations, but it matches how all
  // BAC member bodies sit between consecutive declarations.
  let candidate: ast.BacMember | undefined;
  let bound = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cls.members.length; i++) {
    const m = cls.members[i];
    if (m.location.offset <= cursorOffset) { candidate = m; }
    if (m.location.offset > cursorOffset && i > 0) { bound = m.location.offset; break; }
  }
  if (!candidate) { return undefined; }
  // Only the body-bearing kinds matter for local scope.
  if (candidate.kind === 'function' || candidate.kind === 'event' || candidate.kind === 'construction') {
    return cursorOffset < bound ? candidate : undefined;
  }
  return undefined;
}

function collectParamsAndLocals(
  member: ast.BacMember, cursorOffset: number,
  out: Map<string, ResolvedSymbol>,
): void {
  if (member.kind === 'function' || member.kind === 'event') {
    for (const p of member.params) {
      out.set(p.name, { name: p.name, kind: 'param', typeName: typeName(p.type), detail: `: ${formatType(p.type)}` });
    }
  }
  // The body of all three kinds is `BacBlockStmt`. Walk it and collect
  // var_decl/let statements whose declaration is before the cursor.
  const body = (member as { body?: ast.BacBlockStmt }).body;
  if (body) { collectLocalsInBlock(body, cursorOffset, out); }
}

function collectLocalsInBlock(
  block: ast.BacBlockStmt, cursorOffset: number,
  out: Map<string, ResolvedSymbol>,
): void {
  for (const s of block.statements) {
    // A statement past the cursor can't shadow anything earlier — stop walking.
    if (s.location.offset > cursorOffset) { return; }
    visitStmtForLocals(s, cursorOffset, out);
  }
}

function visitStmtForLocals(
  s: ast.BacStmt, cursorOffset: number,
  out: Map<string, ResolvedSymbol>,
): void {
  switch (s.kind) {
    case 'var_decl': {
      const tn = s.type ? typeName(s.type) : undefined;
      out.set(s.name, {
        name: s.name, kind: 'local',
        typeName: tn,
        detail:   s.type ? `: ${formatType(s.type)}` : '',
      });
      return;
    }
    case 'block':
      collectLocalsInBlock(s, cursorOffset, out);
      return;
    case 'if': {
      // The if-let binding lives only in the then-branch. We don't know if the
      // cursor is in the then-branch (no end-locations), so we add it for both
      // — better to over-suggest than miss the binding.
      if (s.letName) {
        out.set(s.letName, { name: s.letName, kind: 'local' });
      }
      collectLocalsInBlock(s.then, cursorOffset, out);
      if (s.else && s.else.kind !== 'if') {
        if (s.else.kind === 'block') { collectLocalsInBlock(s.else, cursorOffset, out); }
      } else if (s.else && s.else.kind === 'if') {
        visitStmtForLocals(s.else, cursorOffset, out);
      }
      return;
    }
    case 'for':
      out.set(s.bindingName, {
        name: s.bindingName, kind: 'local',
        typeName: s.bindingType ? typeName(s.bindingType) : undefined,
      });
      collectLocalsInBlock(s.body, cursorOffset, out);
      return;
    case 'while':
      collectLocalsInBlock(s.body, cursorOffset, out);
      return;
    default:
      return;
  }
}

// ─── Type formatting ────────────────────────────────────────────────────────

function typeName(t: ast.BacTypeRef): string { return t.baseName; }

function formatType(t: ast.BacTypeRef): string {
  let s = t.baseName;
  if (t.genericArgs.length > 0) {
    s += '<' + t.genericArgs.map(formatType).join(', ') + '>';
  }
  for (let i = 0; i < t.arrayDepth; i++) { s += '[]'; }
  return s;
}

function formatFunctionSignature(f: ast.BacFunctionDecl): string {
  const params = f.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
  const ret    = f.returnType ? `: ${formatType(f.returnType)}` : '';
  return `(${params})${ret}`;
}

function formatEventSignature(e: ast.BacEventDecl): string {
  const params = e.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
  return `(${params})`;
}

// ─── Completion item generation ─────────────────────────────────────────────

export function buildCompletionItems(
  ctx: CursorContext, scope: ScopeAt,
): CompletionItem[] {
  if (ctx.kind === 'top-level') {
    return buildTopLevelItems(scope, ctx.prefix);
  }
  return buildMemberItems(ctx.receiver!, scope, ctx.prefix);
}

function buildTopLevelItems(scope: ScopeAt, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];

  // Locals/params come first (sortText "0_…") so they win in the ranked list
  // when there's a tie with a class member of the same name.
  for (const sym of scope.locals.values()) {
    if (!matchesPrefix(sym.name, prefix)) { continue; }
    items.push(toCompletionItem(sym, '0'));
  }
  for (const sym of scope.classMembers) {
    if (!matchesPrefix(sym.name, prefix)) { continue; }
    items.push(toCompletionItem(sym, '1'));
  }

  return items;
}

function buildMemberItems(receiver: string, scope: ScopeAt, prefix: string): CompletionItem[] {
  // Receiver lookup order matches identifier resolution: locals → class members.
  // For Slice 1 we only have a useful answer when the receiver type is `this`
  // (or a script-declared class, which is rare). Engine types fall through to
  // an empty list — Slice 2 fills these via the running editor.
  if (receiver === 'this' || receiver === scope.classDecl?.name) {
    return scope.classMembers
      .filter(s => matchesPrefix(s.name, prefix))
      .map(s => toCompletionItem(s, '0'));
  }
  // Resolve the receiver in the local scope to find its declared type.
  // We don't have a script-class registry yet, so we can only complete when
  // the type *is* this class. Otherwise: empty (Slice 2 will pick this up).
  const local = scope.locals.get(receiver) ?? scope.classMembers.find(s => s.name === receiver);
  if (local?.typeName === scope.classDecl?.name) {
    return scope.classMembers
      .filter(s => matchesPrefix(s.name, prefix))
      .map(s => toCompletionItem(s, '0'));
  }
  return [];
}

function matchesPrefix(name: string, prefix: string): boolean {
  if (!prefix) { return true; }
  // Case-insensitive prefix match — VS Code does its own fuzzy ranking on top.
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

function toCompletionItem(sym: ResolvedSymbol, sortBucket: string): CompletionItem {
  return {
    label:    sym.name,
    kind:     completionKindOf(sym.kind),
    detail:   sym.detail,
    sortText: `${sortBucket}_${sym.name}`,
  };
}

function completionKindOf(k: ResolvedSymbol['kind']): CompletionItemKind {
  switch (k) {
    case 'function':  return CompletionItemKind.Function;
    case 'event':     return CompletionItemKind.Event;
    case 'var':       return CompletionItemKind.Field;
    case 'component': return CompletionItemKind.Field;
    case 'param':     return CompletionItemKind.Variable;
    case 'local':     return CompletionItemKind.Variable;
    case 'class':     return CompletionItemKind.Class;
  }
}

// ─── Engine-coupled (Slice 2): completions from the running editor ─────────

/**
 * Same shape as `buildCompletionItems` but also asks the engine proxy for
 * member-access completions when we know the receiver's type. Falls back to
 * the sync TS-only result when no proxy is supplied or the engine path can't
 * answer (no editor running, type not loaded, request timed out).
 */
export async function buildCompletionItemsAsync(
  ctx: CursorContext,
  scope: ScopeAt,
  proxy?: BacEngineProxy,
): Promise<CompletionItem[]> {
  const tsItems = buildCompletionItems(ctx, scope);
  if (!proxy) { return tsItems; }

  if (ctx.kind === 'member-access') {
    const engineType = resolveReceiverEngineType(ctx.receiver!, scope);
    if (!engineType) { return tsItems; }
    const members = await proxy.completeType(engineType);
    if (!members) { return tsItems; }
    return mergeByLabel(tsItems, engineMembersToItems(members, ctx.prefix));
  }

  // Asset body: editable properties of the parent class. The engine path
  // already filters to BlueprintVisible | Edit on the property side, which
  // covers everything an `asset Foo : Parent { Property = Value }` body can
  // legally name. Functions are dropped — they're not assignable in this
  // context. No prefix gating here: an asset body is a small, finite list
  // of fields, so an empty prefix is a valid "show me everything" query.
  if (ctx.kind === 'top-level' && scope.assetContext) {
    const members = await proxy.completeType(scope.assetContext.parentTypeName);
    if (members) {
      return mergeByLabel(tsItems, enginePropertiesToItems(members, ctx.prefix));
    }
  }

  // Row body: editable fields of the row struct.
  if (ctx.kind === 'top-level' && scope.rowContext) {
    const struct = await proxy.completeStruct(scope.rowContext.rowStructName);
    if (struct) {
      return mergeByLabel(tsItems, engineStructFieldsToItems(struct, ctx.prefix));
    }
  }

  // Top-level partial: also offer the parent class's BlueprintCallable
  // functions and visible properties — typing `S` should suggest
  // `SetActorLocation`, `SetActorHiddenInGame`, etc. Skip the call when the
  // user hasn't typed anything yet (an empty prefix would dump every
  // inherited UFUNCTION + property into the menu).
  if (ctx.kind === 'top-level' && ctx.prefix.length > 0 && scope.classDecl?.parentTypeName) {
    const members = await proxy.completeType(scope.classDecl.parentTypeName);
    if (members) {
      return mergeByLabel(tsItems, engineMembersToItems(members, ctx.prefix));
    }
  }
  return tsItems;
}

function resolveReceiverEngineType(receiver: string, scope: ScopeAt): string | undefined {
  // For `super`, the engine type is the script class's parent. For `this` (or
  // the script class name), we still ask for the parent because script-side
  // members are already in `tsItems` and we want the parent's UFUNCTIONs on top.
  if (receiver === 'super') { return scope.classDecl?.parentTypeName; }
  if (receiver === 'this' || (scope.classDecl && receiver === scope.classDecl.name)) {
    return scope.classDecl?.parentTypeName;
  }

  // Bare-identifier receiver: look up its declared type in the visible scope.
  const local = scope.locals.get(receiver);
  if (local?.typeName) { return local.typeName; }
  const member = scope.classMembers.find(s => s.name === receiver);
  if (member?.typeName) { return member.typeName; }
  return undefined;
}

function engineMembersToItems(members: EngineTypeMembers, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const f of members.functions) {
    if (!matchesPrefix(f.name, prefix)) { continue; }
    const params = f.params.map(p => `${p.name}: ${p.type}`).join(', ');
    const ret    = f.returnType ? `: ${f.returnType}` : '';
    const tag    = f.isLatent ? ' [latent]' : f.isPure ? ' [pure]' : '';
    items.push({
      label:         f.name,
      kind:          CompletionItemKind.Method,
      detail:        `(${params})${ret}${tag}`,
      documentation: f.doc,
      // Sort engine items after script-known ones (top-level partial uses 0/1).
      sortText:      `2_${f.name}`,
    });
  }
  for (const p of members.properties) {
    if (!matchesPrefix(p.name, prefix)) { continue; }
    items.push({
      label:         p.name,
      kind:          CompletionItemKind.Field,
      detail:        `: ${p.type}${p.readOnly ? ' (read-only)' : ''}`,
      documentation: p.doc,
      sortText:      `2_${p.name}`,
    });
  }
  return items;
}

// Asset-body completion: only the properties side of `complete-type` is
// useful (UFunctions are not assignable in `asset Foo : Parent { … }`).
function enginePropertiesToItems(members: EngineTypeMembers, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const p of members.properties) {
    if (!matchesPrefix(p.name, prefix)) { continue; }
    items.push({
      label:         p.name,
      kind:          CompletionItemKind.Field,
      detail:        `: ${p.type}${p.readOnly ? ' (read-only)' : ''}`,
      documentation: p.doc,
      sortText:      `2_${p.name}`,
    });
  }
  return items;
}

// Row-body completion: every UScriptStruct field is assignable.
function engineStructFieldsToItems(struct: EngineStructMembers, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const f of struct.fields) {
    if (!matchesPrefix(f.name, prefix)) { continue; }
    items.push({
      label:         f.name,
      kind:          CompletionItemKind.Field,
      detail:        `: ${f.type}`,
      documentation: f.doc,
      sortText:      `2_${f.name}`,
    });
  }
  return items;
}

function mergeByLabel(primary: CompletionItem[], secondary: CompletionItem[]): CompletionItem[] {
  const have = new Set(primary.map(i => i.label));
  const out  = primary.slice();
  for (const item of secondary) { if (!have.has(item.label)) { out.push(item); } }
  return out;
}
