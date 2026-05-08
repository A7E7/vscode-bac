// textDocument/hover — markdown popup describing the identifier under the cursor.
//
// Shape of the response:
//   • Class member  →  signature + decorators + (if function) body summary
//   • Param / local →  "name: type"
//   • Engine member →  signature + UClass + tooltip from UE metadata, fetched
//                      from the running editor's completion server when wired.
//
// The engine path is best-effort: if the proxy isn't connected (no editor
// open) we degrade to the TS-only answer. We never block the hover for more
// than a couple seconds — `BacEngineProxy.completeType` handles its own
// timeout, but we wrap with a short race here too so VS Code doesn't show
// the hover popup spinner forever.

import { Hover, MarkupKind } from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { findQualifiedIdentAt, rangeFromSpan } from './text-utils';
import { findClassMember } from './definition';
import { BacEngineProxy, EngineFunction, EngineProperty, EngineTypeMembers } from '../completion/engine-proxy';

export interface HoverContext {
  text:   string;
  ast:    ast.BacScriptAst;
  offset: number;
  proxy?: BacEngineProxy;
}

export async function buildHover(ctx: HoverContext): Promise<Hover | undefined> {
  const ident = findQualifiedIdentAt(ctx.text, ctx.offset);
  if (!ident) { return undefined; }
  const cls = ctx.ast.class;
  if (!cls) { return undefined; }

  const range = rangeFromSpan(ctx.text, ident.start, ident.end);
  const lspRange = {
    start: { line: range.startLine, character: range.startColumn },
    end:   { line: range.endLine,   character: range.endColumn   },
  };

  // ── Qualified: receiver.name ──────────────────────────────────────────
  if (ident.receiver) {
    const receiverIsSelf =
      ident.receiver === 'this' || ident.receiver === 'super' ||
      ident.receiver === cls.name;
    if (receiverIsSelf) {
      const m = findClassMember(cls, ident.name);
      if (m) { return md(formatClassMember(m), lspRange); }
    }

    // Engine path: resolve receiver type, ask the proxy.
    if (ctx.proxy) {
      const recvType = resolveReceiverType(ident.receiver, cls);
      if (recvType) {
        const members = await ctx.proxy.completeType(recvType);
        if (members) {
          const found = findEngineMember(members, ident.name);
          if (found) {
            return md(formatEngineMember(found, members.resolvedClassName), lspRange);
          }
        }
      }
    }
    return undefined;
  }

  // ── Unqualified ───────────────────────────────────────────────────────
  const containingMember = findContainingMember(cls, ctx.offset);
  if (containingMember) {
    if (containingMember.kind === 'function' || containingMember.kind === 'event') {
      const param = containingMember.params.find(p => p.name === ident.name);
      if (param) { return md(`(parameter) **${param.name}**: \`${formatType(param.type)}\``, lspRange); }
    }
    const local = findLocalBefore(containingMember, ident.name, ctx.offset);
    if (local) { return md(`(local) **${local.name}**${local.typeHint ? `: \`${local.typeHint}\`` : ''}`, lspRange); }
  }

  const m = findClassMember(cls, ident.name);
  if (m) { return md(formatClassMember(m), lspRange); }

  // Top-level identifier that doesn't resolve script-side: try the engine
  // (treats it like a top-level call to a parent UFUNCTION / Kismet helper).
  if (ctx.proxy && cls.parentTypeName) {
    const members = await ctx.proxy.completeType(cls.parentTypeName);
    if (members) {
      const found = findEngineMember(members, ident.name);
      if (found) {
        return md(formatEngineMember(found, members.resolvedClassName), lspRange);
      }
    }
  }
  return undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface SimpleRange { start: { line: number; character: number }; end: { line: number; character: number } }
function md(content: string, range: SimpleRange): Hover {
  return {
    contents: { kind: MarkupKind.Markdown, value: content },
    range,
  };
}

function resolveReceiverType(receiver: string, cls: ast.BacClassDecl): string | undefined {
  if (receiver === 'super') { return cls.parentTypeName; }
  if (receiver === 'this' || receiver === cls.name) { return cls.parentTypeName; }
  for (const m of cls.members) {
    if ((m.kind === 'variable' || m.kind === 'component') && m.name === receiver) {
      return m.type.baseName;
    }
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

interface LocalHit { name: string; typeHint?: string }
function findLocalBefore(m: ast.BacMember, name: string, cursorOffset: number): LocalHit | undefined {
  const body = (m as { body?: ast.BacBlockStmt }).body;
  if (!body) { return undefined; }
  return walkBlock(body, name, cursorOffset);
}
function walkBlock(b: ast.BacBlockStmt, name: string, cursorOffset: number): LocalHit | undefined {
  for (const s of b.statements) {
    if (s.location.offset > cursorOffset) { return undefined; }
    const found = walkStmt(s, name, cursorOffset);
    if (found) { return found; }
  }
  return undefined;
}
function walkStmt(s: ast.BacStmt, name: string, cursorOffset: number): LocalHit | undefined {
  switch (s.kind) {
    case 'var_decl':
      if (s.name === name) { return { name, typeHint: s.type ? formatType(s.type) : undefined }; }
      return undefined;
    case 'block':
      return walkBlock(s, name, cursorOffset);
    case 'if': {
      if (s.letName === name) { return { name }; }
      const f = walkBlock(s.then, name, cursorOffset);
      if (f) { return f; }
      if (s.else) { return walkStmt(s.else, name, cursorOffset); }
      return undefined;
    }
    case 'for':
      if (s.bindingName === name) {
        return { name, typeHint: s.bindingType ? formatType(s.bindingType) : undefined };
      }
      return walkBlock(s.body, name, cursorOffset);
    case 'while':
      return walkBlock(s.body, name, cursorOffset);
    default:
      return undefined;
  }
}

function findEngineMember(
  members: EngineTypeMembers, name: string,
): { kind: 'function'; func: EngineFunction } | { kind: 'property'; prop: EngineProperty } | undefined {
  for (const f of members.functions)  { if (f.name === name) { return { kind: 'function', func: f }; } }
  for (const p of members.properties) { if (p.name === name) { return { kind: 'property', prop: p }; } }
  return undefined;
}

// ─── Markdown formatting ──────────────────────────────────────────────────

function formatClassMember(m: ast.BacMember): string {
  const decoratorLines = (m as { decorators?: ast.BacDecorator[] }).decorators
    ?.map(formatDecorator).join('\n') ?? '';
  const decoratorsBlock = decoratorLines ? '\n```bac\n' + decoratorLines + '\n```\n' : '';

  switch (m.kind) {
    case 'variable':
      return [
        `\`var\` **${m.name}**: \`${formatType(m.type)}\``,
        decoratorsBlock,
      ].filter(Boolean).join('\n');
    case 'component':
      return [
        `\`component\` **${m.name}**: \`${formatType(m.type)}\`` +
          (m.attachParent ? ` *attach* \`${m.attachParent}\`` : ''),
        decoratorsBlock,
      ].filter(Boolean).join('\n');
    case 'function': {
      const params = m.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
      const ret    = m.returnType ? `: ${formatType(m.returnType)}` : '';
      const tag    = m.isPure ? ' (pure)' : '';
      const ifa    = m.interfaceImpl ? `\n\nimplements **${m.interfaceImpl}**` : '';
      return [
        `\`function\` **${m.name}**(${params})${ret}${tag}`,
        decoratorsBlock + ifa,
      ].filter(Boolean).join('\n');
    }
    case 'event': {
      const params = m.params.map(p => `${p.name}: ${formatType(p.type)}`).join(', ');
      return [
        `\`event\` **${m.name}**(${params})`,
        decoratorsBlock,
      ].filter(Boolean).join('\n');
    }
    case 'construction':
      return '`construction` block';
    case 'widget': {
      const childCount = m.children.length;
      const tail = childCount === 0 ? '' : ` (${childCount} child widget${childCount === 1 ? '' : 's'})`;
      return [
        `\`widget\` **${m.name}**: \`${formatType(m.type)}\`${tail}`,
        decoratorsBlock,
      ].filter(Boolean).join('\n');
    }
  }
}

function formatDecorator(d: ast.BacDecorator): string {
  if (d.args.length === 0) { return `@${d.name}`; }
  const args = d.args.map(a => {
    const v = formatExpr(a.value);
    return a.name ? `${a.name} = ${v}` : v;
  }).join(', ');
  return `@${d.name}(${args})`;
}

function formatExpr(e: ast.BacExpr): string {
  switch (e.kind) {
    case 'int_lit':    return String(e.value);
    case 'float_lit':  return String(e.value);
    case 'string_lit': return `"${e.value}"`;
    case 'bool_lit':   return e.value ? 'true' : 'false';
    case 'none_lit':   return 'none';
    case 'ident':      return e.name;
    case 'this':       return 'this';
    case 'super':      return 'super';
    default:           return '…';
  }
}

function formatEngineMember(
  hit: { kind: 'function'; func: EngineFunction } | { kind: 'property'; prop: EngineProperty },
  ownerName: string,
): string {
  if (hit.kind === 'function') {
    const f = hit.func;
    const params = f.params.map(p => `${p.name}: ${p.type}` + (p.isOut ? ' &' : '')).join(', ');
    const ret    = f.returnType ? `: ${f.returnType}` : '';
    const tag    = f.isLatent ? ' [latent]' : f.isPure ? ' [pure]' : '';
    const sig    = `**${f.name}**(${params})${ret}${tag}`;
    const owner  = `\n\n*UFUNCTION on \`${ownerName}\`*`;
    const cat    = f.category ? `\n\n*Category:* ${f.category}` : '';
    const doc    = f.doc       ? `\n\n${f.doc}`                  : '';
    return sig + owner + cat + doc;
  }
  const p = hit.prop;
  const sig   = `**${p.name}**: \`${p.type}\`` + (p.readOnly ? ' *(read-only)*' : '');
  const owner = `\n\n*Property on \`${ownerName}\`*`;
  const cat   = p.category ? `\n\n*Category:* ${p.category}` : '';
  const doc   = p.doc       ? `\n\n${p.doc}`                  : '';
  return sig + owner + cat + doc;
}

function formatType(t: ast.BacTypeRef): string {
  let s = t.baseName;
  if (t.genericArgs.length > 0) {
    s += '<' + t.genericArgs.map(formatType).join(', ') + '>';
  }
  for (let i = 0; i < t.arrayDepth; i++) { s += '[]'; }
  return s;
}
