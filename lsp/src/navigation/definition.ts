// textDocument/definition — F12 / Cmd-click on an identifier jumps to its
// declaration. TS-only resolver: handles params, locals, and class-level
// members. Engine-side targets (parent UFUNCTION, UPROPERTY) are out of scope
// for now — there's no LSP location for them inside the .bac project.
//
// Resolution order matches the validator's identifier resolver:
//   1. Local declared earlier in the same function/event body
//   2. Parameter of the enclosing function/event
//   3. Class-level member (var, component, function, event)
//
// For qualified `Receiver.Name` we only resolve when Receiver is `this` /
// `super` / the script class name, in which case Name has to be a class
// member. Anything else (engine-typed receiver) returns null.

import { Location, Range } from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { findQualifiedIdentAt } from './text-utils';
import { BacSourceLocation } from '../script/diagnostics';

export interface DefinitionContext {
  uri:    string;
  text:   string;
  ast:    ast.BacScriptAst;
  offset: number;
}

export function findDefinition(ctx: DefinitionContext): Location | undefined {
  const ident = findQualifiedIdentAt(ctx.text, ctx.offset);
  if (!ident) { return undefined; }

  const cls = ctx.ast.class;
  if (!cls) { return undefined; }

  const containingMember = findContainingMember(cls, ctx.offset);

  // Qualified — only handle this/super/className → class member.
  if (ident.receiver) {
    const receiverIsSelf =
      ident.receiver === 'this' || ident.receiver === 'super' ||
      ident.receiver === cls.name;
    if (!receiverIsSelf) { return undefined; }
    const member = findClassMember(cls, ident.name);
    if (!member) { return undefined; }
    return locationOfDecl(ctx, member.location, ident.name);
  }

  // Unqualified resolution — walk innermost scope outward.
  if (containingMember) {
    const local = findLocalBefore(containingMember, ident.name, ctx.offset);
    if (local) { return locationOfDecl(ctx, local, ident.name); }
    const param = findParam(containingMember, ident.name);
    if (param) { return locationOfDecl(ctx, param, ident.name); }
  }
  const member = findClassMember(cls, ident.name);
  if (member) { return locationOfDecl(ctx, member.location, ident.name); }

  return undefined;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

export function findClassMember(cls: ast.BacClassDecl, name: string): ast.BacMember | undefined {
  for (const m of cls.members) {
    if (m.kind === 'construction') { continue; }
    if (m.name === name) { return m; }
  }
  return undefined;
}

function findContainingMember(cls: ast.BacClassDecl, offset: number): ast.BacMember | undefined {
  let candidate: ast.BacMember | undefined;
  let bound = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cls.members.length; i++) {
    const m = cls.members[i];
    if (m.location.offset <= offset) { candidate = m; }
    if (m.location.offset > offset && i > 0) { bound = m.location.offset; break; }
  }
  if (!candidate) { return undefined; }
  if (candidate.kind !== 'function' && candidate.kind !== 'event' && candidate.kind !== 'construction') {
    return undefined;
  }
  return offset < bound ? candidate : undefined;
}

function findParam(m: ast.BacMember, name: string): BacSourceLocation | undefined {
  if (m.kind !== 'function' && m.kind !== 'event') { return undefined; }
  // Params don't carry their own SourceLocation; fall back to the member's
  // location. Goto-def will land on the function header — close enough.
  if (m.params.some(p => p.name === name)) { return m.location; }
  return undefined;
}

function findLocalBefore(m: ast.BacMember, name: string, cursorOffset: number): BacSourceLocation | undefined {
  const body = (m as { body?: ast.BacBlockStmt }).body;
  if (!body) { return undefined; }
  return walkBlock(body, name, cursorOffset);
}

function walkBlock(b: ast.BacBlockStmt, name: string, cursorOffset: number): BacSourceLocation | undefined {
  for (const s of b.statements) {
    if (s.location.offset > cursorOffset) { return undefined; }
    const found = walkStmt(s, name, cursorOffset);
    if (found) { return found; }
  }
  return undefined;
}

function walkStmt(s: ast.BacStmt, name: string, cursorOffset: number): BacSourceLocation | undefined {
  switch (s.kind) {
    case 'var_decl':
      return s.name === name ? s.location : undefined;
    case 'block':
      return walkBlock(s, name, cursorOffset);
    case 'if': {
      if (s.letName === name) { return s.location; }
      const found = walkBlock(s.then, name, cursorOffset);
      if (found) { return found; }
      if (s.else) { return walkStmt(s.else, name, cursorOffset); }
      return undefined;
    }
    case 'for':
      if (s.bindingName === name) { return s.location; }
      return walkBlock(s.body, name, cursorOffset);
    case 'while':
      return walkBlock(s.body, name, cursorOffset);
    default:
      return undefined;
  }
}

// ─── Range computation ─────────────────────────────────────────────────────

function locationOfDecl(ctx: DefinitionContext, declLoc: BacSourceLocation, name: string): Location {
  // BacSourceLocation is 1-based. We try to point selectionRange at the
  // identifier name itself by scanning forward from the declaration start.
  const startOffset = declLoc.offset;
  const idx = ctx.text.indexOf(name, startOffset);
  const nameStart = (idx >= 0 && idx - startOffset < 200) ? idx : startOffset;
  const nameEnd   = nameStart + name.length;
  const range: Range = {
    start: positionFor(ctx.text, nameStart),
    end:   positionFor(ctx.text, nameEnd),
  };
  return { uri: ctx.uri, range };
}

function positionFor(text: string, offset: number): { line: number; character: number } {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0A) { line++; col = 0; } else { col++; }
  }
  return { line, character: col };
}
