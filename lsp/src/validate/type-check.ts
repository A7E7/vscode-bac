// 1:1 port of BacTypeCheck.cpp.
// Diagnostic codes BAC23xx are wire-stable.

import { BacDiagnostics } from '../script/diagnostics';
import * as ast from '../script/ast';

export function runTypeCheck(scriptAst: ast.BacScriptAst, out: BacDiagnostics): void {
  const cls = scriptAst.class;
  if (!cls) { return; }
  for (const m of cls.members) { checkMember(m, out); }
}

// Returns expected type-arg count, or -1 for unknown generics.
//
// Both BAC vocabulary (`Set<T>`, `Map<K,V>`, `Class<T>`, `Soft*<T>`) and the
// UE-native names (`TArray<T>`, `TSet<T>`, `TMap<K,V>`, `TSoftObjectPtr<T>`,
// `TSoftClassPtr<T>`, `TSubclassOf<T>`) are accepted as synonyms — anyone
// copying a BP type from C++ familiarity expects the T-prefixed forms to
// work. The transcriber always emits the BAC vocabulary, so a round-trip
// canonicalises onto one form.
function genericArity(name: string): number {
  switch (name) {
    // BAC vocabulary
    case 'Set':        return 1;
    case 'Map':        return 2;
    case 'Class':      return 1;
    case 'SoftClass':  return 1;
    case 'SoftObject': return 1;
    // UE-native synonyms
    case 'TArray':         return 1;
    case 'TSet':           return 1;
    case 'TMap':           return 2;
    case 'TSubclassOf':    return 1;
    case 'TSoftObjectPtr': return 1;
    case 'TSoftClassPtr':  return 1;
  }
  return -1;
}

function checkTypeRef(t: ast.BacTypeRef, out: BacDiagnostics): void {
  const expected = genericArity(t.baseName);
  if (expected >= 0) {
    if (t.genericArgs.length !== expected) {
      out.items.push({
        severity: 'error',
        code:     'BAC2310',
        location: t.location,
        message:  `Type '${t.baseName}' expects ${expected} generic argument(s) but got ${t.genericArgs.length}.`,
      });
    }
  } else if (t.genericArgs.length > 0) {
    out.items.push({
      severity: 'warning',
      code:     'BAC2311',
      location: t.location,
      message:  `Type '${t.baseName}' is not a known generic but received ${t.genericArgs.length} generic argument(s); they will be ignored at compile time.`,
    });
  }
  for (const arg of t.genericArgs) { checkTypeRef(arg, out); }
}

// ─── Primitive-literal compatibility ───────────────────────────────────────
type PrimKind = 'unknown' | 'bool' | 'int' | 'float' | 'string' | 'name';

function classifyPrimitive(name: string): PrimKind {
  if (name === 'bool')                                       { return 'bool';   }
  if (name === 'int' || name === 'int64' || name === 'byte') { return 'int';    }
  if (name === 'float')                                      { return 'float';  }
  if (name === 'string' || name === 'text')                  { return 'string'; }
  if (name === 'name')                                       { return 'name';   }
  return 'unknown';
}

function describeLiteralKind(k: ast.BacExpr['kind']): string {
  switch (k) {
    case 'int_lit':    return 'int literal';
    case 'float_lit':  return 'float literal';
    case 'string_lit': return 'string literal';
    case 'bool_lit':   return 'bool literal';
    case 'none_lit':   return "'none'";
    default:           return 'expression';
  }
}

function literalFitsPrim(p: PrimKind, k: ast.BacExpr['kind']): boolean {
  switch (p) {
    case 'bool':   return k === 'bool_lit';
    case 'int':    return k === 'int_lit';
    case 'float':  return k === 'int_lit' || k === 'float_lit';
    case 'string': return k === 'string_lit';
    case 'name':   return k === 'string_lit';
    default:       return true;
  }
}

function checkLiteralAgainstPrim(t: ast.BacTypeRef, value: ast.BacExpr, out: BacDiagnostics): void {
  const p = classifyPrimitive(t.baseName);
  if (p === 'unknown') { return; }

  const isLit =
    value.kind === 'int_lit'    || value.kind === 'float_lit' ||
    value.kind === 'string_lit' || value.kind === 'bool_lit'  ||
    value.kind === 'none_lit';
  if (!isLit) { return; }

  if (value.kind === 'none_lit') {
    out.items.push({
      severity: 'error',
      code:     'BAC2320',
      location: value.location,
      message:  `Cannot assign 'none' to primitive type '${t.baseName}'.`,
    });
    return;
  }

  if (!literalFitsPrim(p, value.kind)) {
    out.items.push({
      severity: 'error',
      code:     'BAC2321',
      location: value.location,
      message:  `Cannot assign ${describeLiteralKind(value.kind)} to variable of type '${t.baseName}'.`,
    });
  }
}

function checkMember(m: ast.BacMember, out: BacDiagnostics): void {
  switch (m.kind) {
    case 'variable':
      checkTypeRef(m.type, out);
      if (m.initializer) { checkLiteralAgainstPrim(m.type, m.initializer, out); }
      return;
    case 'component':
      checkTypeRef(m.type, out);
      return;
    case 'function':
      for (const p of m.params) {
        checkTypeRef(p.type, out);
        if (p.default) { checkLiteralAgainstPrim(p.type, p.default, out); }
      }
      if (m.returnType) { checkTypeRef(m.returnType, out); }
      return;
    case 'event':
      for (const p of m.params) {
        checkTypeRef(p.type, out);
        if (p.default) { checkLiteralAgainstPrim(p.type, p.default, out); }
      }
      return;
    default: return;
  }
}
