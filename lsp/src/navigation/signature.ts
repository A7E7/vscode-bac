// textDocument/signatureHelp — parameter hints inside an open call.
//
// The user types `Mesh.SetVisibility(` and we show
// `(NewVisibility: bool, bPropagate: bool): void` with the active parameter
// underlined. Subsequent `,` keystrokes advance the active parameter.
//
// Strategy:
//   1. Text-level cursor analysis walks back through balanced bracket pairs
//      to find the unmatched `(` that starts the current call. The receiver
//      identifier (if any) and function name sit immediately to its left.
//      Counting commas at the same depth between `(` and cursor gives the
//      active parameter index.
//   2. Resolve the function:
//        - script class members (functions/events declared in the .bac file)
//        - engine UFUNCTIONs reachable through the proxy when receiver type
//          (or parent class for unqualified calls) is known
//   3. Render a `SignatureInformation` with `parameters` keyed by character
//      offsets within the rendered label, so the editor highlights the
//      active param substring.
//
// String / comment skipping is intentionally minimal — the parser already
// rejects malformed input; we just need a best-effort cursor context.

import {
  SignatureHelp, SignatureInformation, ParameterInformation,
} from 'vscode-languageserver/node';
import * as ast from '../script/ast';
import { BacEngineProxy, EngineFunction, EngineTypeMembers } from '../completion/engine-proxy';

export interface SignatureContext {
  text:   string;
  ast:    ast.BacScriptAst;
  offset: number;
  proxy?: BacEngineProxy;
}

export async function buildSignatureHelp(ctx: SignatureContext): Promise<SignatureHelp | undefined> {
  const callCtx = findOpenCall(ctx.text, ctx.offset);
  if (!callCtx) { return undefined; }
  const cls = ctx.ast.class;
  if (!cls) { return undefined; }

  // ── Script-defined function or event ─────────────────────────────────────
  for (const m of cls.members) {
    if ((m.kind === 'function' || m.kind === 'event') && m.name === callCtx.funcName) {
      return {
        signatures: [signatureFromScriptMember(m)],
        activeSignature: 0,
        activeParameter: clampActive(callCtx.argIndex, m.params.length),
      };
    }
  }

  // ── Engine path ─────────────────────────────────────────────────────────
  if (ctx.proxy) {
    let className: string | undefined;
    if (callCtx.receiver) {
      // Resolve the receiver's declared type via class members.
      if (callCtx.receiver === 'super' || callCtx.receiver === 'this' ||
          callCtx.receiver === cls.name) {
        className = cls.parentTypeName;
      } else {
        for (const m of cls.members) {
          if ((m.kind === 'variable' || m.kind === 'component') && m.name === callCtx.receiver) {
            className = m.type.baseName;
            break;
          }
        }
      }
    } else {
      // Unqualified call — could be a parent UFUNCTION (e.g. `SetActorLocation(…)`).
      className = cls.parentTypeName;
    }
    if (className) {
      const members = await ctx.proxy.completeType(className);
      if (members) {
        const fn = findEngineFunction(members, callCtx.funcName);
        if (fn) {
          const sig = signatureFromEngineFunction(fn, members.resolvedClassName);
          return {
            signatures: [sig],
            activeSignature: 0,
            activeParameter: clampActive(callCtx.argIndex, fn.params.length),
          };
        }
      }
    }
  }
  return undefined;
}

// ─── Cursor context ───────────────────────────────────────────────────────

interface OpenCall {
  funcName:  string;
  receiver?: string;
  argIndex:  number;
}

function findOpenCall(text: string, offset: number): OpenCall | undefined {
  // Walk left from the cursor, counting bracket depth and commas at depth 0.
  // Stop when we find an unmatched `(` — that's the call we're inside.
  let i = Math.min(offset, text.length);
  let depth    = 0;
  let argIndex = 0;
  while (i > 0) {
    i--;
    const c = text.charCodeAt(i);
    if (c === 0x29 || c === 0x5D || c === 0x7D) { depth++; continue; }              // ) ] }
    if (c === 0x5B || c === 0x7B) { if (depth === 0) { return undefined; } depth--; continue; } // [ {
    if (c === 0x28) {
      if (depth === 0) {
        // Found the open paren we're inside. Function name sits to the left.
        return parseCalleeBefore(text, i, argIndex);
      }
      depth--;
      continue;
    }
    if (c === 0x2C && depth === 0) { argIndex++; continue; }                         // , at depth 0 → next arg
    // Skip string literals so commas inside don't count as separators.
    if (c === 0x22) { i = skipBackString(text, i); continue; }                       // "
    // Stop at statement boundaries — if we hit `;` `{` or `}` outside any
    // bracket, we weren't inside a call to begin with.
    if (c === 0x7B || c === 0x7D || c === 0x3B) { return undefined; }                // { } ;
  }
  return undefined;
}

function parseCalleeBefore(text: string, parenOffset: number, argIndex: number): OpenCall | undefined {
  let i = parenOffset;
  while (i > 0 && isWs(text.charCodeAt(i - 1))) { i--; }
  const nameEnd = i;
  while (i > 0 && isIdentChar(text.charCodeAt(i - 1))) { i--; }
  const funcName = text.slice(i, nameEnd);
  if (!funcName) { return undefined; }
  // Optional receiver to the left of a `.`.
  let j = i;
  while (j > 0 && isWs(text.charCodeAt(j - 1))) { j--; }
  let receiver: string | undefined;
  if (j > 0 && text.charCodeAt(j - 1) === 0x2E) {
    j--;
    while (j > 0 && isWs(text.charCodeAt(j - 1))) { j--; }
    const recvEnd = j;
    while (j > 0 && isIdentChar(text.charCodeAt(j - 1))) { j--; }
    receiver = text.slice(j, recvEnd) || undefined;
  }
  return { funcName, receiver, argIndex };
}

function skipBackString(text: string, doubleQuoteOffset: number): number {
  // Walk left until we find an unescaped opening quote.
  let i = doubleQuoteOffset - 1;
  while (i >= 0) {
    if (text.charCodeAt(i) === 0x22) {
      // Count preceding backslashes; even count = real quote, odd = escaped.
      let bs = 0, k = i - 1;
      while (k >= 0 && text.charCodeAt(k) === 0x5C) { bs++; k--; }
      if (bs % 2 === 0) { return i; }
    }
    i--;
  }
  return -1;  // unterminated string — bail out of the scan
}

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D;
}
function isIdentChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F;
}
function clampActive(idx: number, len: number): number {
  if (len === 0) { return 0; }
  return Math.min(idx, len - 1);
}

// ─── Signature rendering ─────────────────────────────────────────────────

function signatureFromScriptMember(m: ast.BacFunctionDecl | ast.BacEventDecl): SignatureInformation {
  const isFn = m.kind === 'function';
  const params = m.params;
  const ret    = isFn && (m as ast.BacFunctionDecl).returnType
    ? `: ${formatType((m as ast.BacFunctionDecl).returnType!)}`
    : (isFn ? '' : '');
  const tag    = isFn && (m as ast.BacFunctionDecl).isPure ? ' [pure]' : '';

  // Build label and capture per-param substring offsets in the same pass.
  const head     = `${m.name}(`;
  let label      = head;
  const paramInfo: ParameterInformation[] = [];
  for (let i = 0; i < params.length; i++) {
    const p     = params[i];
    const piece = `${p.name}: ${formatType(p.type)}`;
    const start = label.length;
    label += piece;
    paramInfo.push({ label: [start, start + piece.length] });
    if (i < params.length - 1) { label += ', '; }
  }
  label += `)${ret}${tag}`;

  return {
    label,
    parameters:    paramInfo,
    documentation: undefined,
  };
}

function signatureFromEngineFunction(f: EngineFunction, ownerClass: string): SignatureInformation {
  const head     = `${f.name}(`;
  let label      = head;
  const paramInfo: ParameterInformation[] = [];
  for (let i = 0; i < f.params.length; i++) {
    const p     = f.params[i];
    const piece = `${p.name}: ${p.type}` + (p.isOut ? ' &' : '');
    const start = label.length;
    label += piece;
    paramInfo.push({ label: [start, start + piece.length] });
    if (i < f.params.length - 1) { label += ', '; }
  }
  const ret = f.returnType ? `: ${f.returnType}` : '';
  const tag = f.isLatent ? ' [latent]' : f.isPure ? ' [pure]' : '';
  label += `)${ret}${tag}`;

  const docParts: string[] = [`*UFUNCTION on \`${ownerClass}\`*`];
  if (f.category) { docParts.push(`*Category:* ${f.category}`); }
  if (f.doc)      { docParts.push(f.doc); }

  return {
    label,
    parameters: paramInfo,
    documentation: { kind: 'markdown', value: docParts.join('\n\n') },
  };
}

function findEngineFunction(members: EngineTypeMembers, name: string): EngineFunction | undefined {
  for (const f of members.functions) { if (f.name === name) { return f; } }
  return undefined;
}

function formatType(t: ast.BacTypeRef): string {
  let s = t.baseName;
  if (t.genericArgs.length > 0) { s += '<' + t.genericArgs.map(formatType).join(', ') + '>'; }
  for (let i = 0; i < t.arrayDepth; i++) { s += '[]'; }
  return s;
}
