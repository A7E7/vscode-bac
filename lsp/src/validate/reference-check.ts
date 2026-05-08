// 1:1 port of BacReferenceCheck.cpp.
//
// Wire-stable diagnostic codes (BAC2200..BAC2299, BAC22xx). Mirrors the C++
// pass — when a fixture's expected diagnostic exists in either implementation,
// the other should produce it at the same line/column.

import { BacDiagnostics, BacSourceLocation } from '../script/diagnostics';
import * as ast from '../script/ast';

export function runReferenceCheck(scriptAst: ast.BacScriptAst, out: BacDiagnostics): void {
  const cls = scriptAst.class;
  if (!cls) { return; }

  const symbols = buildSymbols(cls, out);
  checkComponentAttachRefs(cls, symbols, out);
  checkAttachCycles(cls, symbols, out);
  checkRepNotifyRefs(cls, symbols, out);
  checkLocalScopes(cls, out);
}

// ─── Class-level symbol tables ─────────────────────────────────────────────
interface ClassSymbols {
  componentNames:   string[];
  components:       Map<string, ast.BacComponentDecl>;
  functions:        Map<string, ast.BacFunctionDecl>;
  allMembersByName: Map<string, ast.BacMember>;
}

function buildSymbols(cls: ast.BacClassDecl, out: BacDiagnostics): ClassSymbols {
  const sym: ClassSymbols = {
    componentNames:   [],
    components:       new Map(),
    functions:        new Map(),
    allMembersByName: new Map(),
  };
  for (const m of cls.members) {
    let name = '';
    switch (m.kind) {
      case 'variable':  name = m.name; break;
      case 'component': {
        name = m.name;
        sym.componentNames.push(m.name);
        sym.components.set(m.name, m);
        break;
      }
      case 'function': {
        name = m.name;
        sym.functions.set(m.name, m);
        break;
      }
      case 'event':        name = m.name; break;
      case 'construction': continue;
    }
    if (!name) { continue; }
    const existing = sym.allMembersByName.get(name);
    if (existing) {
      out.items.push({
        severity: 'error',
        code:     'BAC2210',
        location: m.location,
        message:  `Duplicate member '${name}'.`,
        notes:    [{ message: 'previously declared here', location: existing.location }],
      });
    } else {
      sym.allMembersByName.set(name, m);
    }
  }
  return sym;
}

// ─── Attach refs ───────────────────────────────────────────────────────────
function checkComponentAttachRefs(cls: ast.BacClassDecl, sym: ClassSymbols, out: BacDiagnostics): void {
  for (const m of cls.members) {
    if (m.kind !== 'component') { continue; }
    if (!m.attachParent) { continue; }
    if (!sym.components.has(m.attachParent)) {
      const suggested = closestMatch(m.attachParent, sym.componentNames);
      const fix = suggested
        ? { hint: `Did you mean '${suggested}'?`, fixes: [`replace \`attach ${m.attachParent}\` with \`attach ${suggested}\``] }
        : {};
      out.items.push({
        severity: 'error',
        code:     'BAC2200',
        location: m.location,
        message:  `Component '${m.name}' attaches to '${m.attachParent}', which is not declared in this class.`,
        ...fix,
      });
      continue;
    }
    if (m.attachParent === m.name) {
      out.items.push({
        severity: 'error',
        code:     'BAC2201',
        location: m.location,
        message:  `Component '${m.name}' attaches to itself.`,
      });
    }
  }
}

function checkAttachCycles(cls: ast.BacClassDecl, sym: ClassSymbols, out: BacDiagnostics): void {
  const reported = new Set<string>();
  for (const m of cls.members) {
    if (m.kind !== 'component') { continue; }
    if (!m.attachParent || reported.has(m.name) || m.attachParent === m.name) { continue; }
    const visited = new Set<string>([m.name]);
    const chain   = [m.name];
    let cursor = m.attachParent;
    while (cursor) {
      if (visited.has(cursor)) {
        chain.push(cursor);
        for (const n of chain) { reported.add(n); }
        out.items.push({
          severity: 'error',
          code:     'BAC2202',
          location: m.location,
          message:  `Attach cycle detected: ${chain.join(' -> ')}`,
        });
        break;
      }
      visited.add(cursor);
      chain.push(cursor);
      const found = sym.components.get(cursor);
      if (!found) { break; }   // missing parent already reported
      cursor = found.attachParent;
    }
  }
}

// ─── RepNotify ─────────────────────────────────────────────────────────────
function checkRepNotifyRefs(cls: ast.BacClassDecl, sym: ClassSymbols, out: BacDiagnostics): void {
  for (const m of cls.members) {
    if (m.kind !== 'variable') { continue; }
    for (const d of m.decorators) {
      if (d.name !== 'replicated') { continue; }
      for (const arg of d.args) {
        if (arg.name !== 'repnotify') { continue; }
        if (!arg.value || arg.value.kind !== 'ident') { continue; }
        const fname = arg.value.name;
        const f = sym.functions.get(fname);
        if (!f) {
          const names = Array.from(sym.functions.keys());
          const suggested = closestMatch(fname, names);
          const fix = suggested
            ? { hint: `Did you mean '${suggested}'?`, fixes: [`replace \`repnotify = ${fname}\` with \`repnotify = ${suggested}\``] }
            : {};
          out.items.push({
            severity: 'error',
            code:     'BAC2220',
            location: d.location,
            message:  `@replicated repnotify references function '${fname}', which is not declared.`,
            ...fix,
          });
          continue;
        }
        if (f.params.length !== 0) {
          out.items.push({
            severity: 'error',
            code:     'BAC2221',
            location: d.location,
            message:  `RepNotify function '${fname}' must take no parameters; it has ${f.params.length}.`,
            notes:    [{ message: 'function declared here', location: f.location }],
          });
        }
        if (f.returnType) {
          out.items.push({
            severity: 'error',
            code:     'BAC2222',
            location: d.location,
            message:  `RepNotify function '${fname}' must return void.`,
            notes:    [{ message: 'function declared here', location: f.location }],
          });
        }
      }
    }
  }
}

// ─── Local scopes ──────────────────────────────────────────────────────────
class ScopeStack {
  readonly frames: Array<Map<string, BacSourceLocation>> = [];
  push(): void { this.frames.push(new Map()); }
  pop():  void { this.frames.pop(); }
  /** Returns the existing decl location if duplicate; declares + returns undefined otherwise. */
  tryDeclare(name: string, loc: BacSourceLocation): BacSourceLocation | undefined {
    const top = this.frames[this.frames.length - 1];
    const existing = top.get(name);
    if (existing) { return existing; }
    top.set(name, loc);
    return undefined;
  }
}

function visitBlock(b: ast.BacBlockStmt, scope: ScopeStack, out: BacDiagnostics): void {
  scope.push();
  for (const s of b.statements) { visitStmt(s, scope, out); }
  scope.pop();
}

function visitStmt(s: ast.BacStmt, scope: ScopeStack, out: BacDiagnostics): void {
  switch (s.kind) {
    case 'block': return visitBlock(s, scope, out);
    case 'var_decl': {
      const existing = scope.tryDeclare(s.name, s.location);
      if (existing) {
        out.items.push({
          severity: 'error',
          code:     'BAC2230',
          location: s.location,
          message:  `Local '${s.name}' is already declared in this scope.`,
          notes:    [{ message: 'previously declared here', location: existing }],
        });
      }
      return;
    }
    case 'if': {
      // THEN: fresh scope, if-let binding lives only in THEN.
      scope.push();
      if (s.letName) { scope.tryDeclare(s.letName, s.location); }
      for (const inner of s.then.statements) { visitStmt(inner, scope, out); }
      scope.pop();
      // ELSE: independent scope.
      if (s.else) {
        scope.push();
        visitStmt(s.else, scope, out);
        scope.pop();
      }
      return;
    }
    case 'for': {
      scope.push();
      scope.tryDeclare(s.bindingName, s.location);
      visitBlock(s.body, scope, out);
      scope.pop();
      return;
    }
    case 'while': {
      scope.push();
      visitBlock(s.body, scope, out);
      scope.pop();
      return;
    }
    default: return;  // expr/assign/return/break/continue have no scope effect
  }
}

function checkParamsAndBody(
  ownerKind: string, ownerName: string, ownerLoc: BacSourceLocation,
  params: ast.BacParam[], body: ast.BacBlockStmt | undefined,
  out: BacDiagnostics,
): void {
  const scope = new ScopeStack();
  scope.push(); // signature scope
  for (const p of params) {
    const existing = scope.tryDeclare(p.name, ownerLoc);
    if (existing) {
      out.items.push({
        severity: 'error',
        code:     'BAC2232',
        location: ownerLoc,
        message:  `${ownerKind} '${ownerName}' has duplicate parameter '${p.name}'.`,
      });
    }
  }
  if (body) { visitBlock(body, scope, out); }
}

function checkLocalScopes(cls: ast.BacClassDecl, out: BacDiagnostics): void {
  for (const m of cls.members) {
    switch (m.kind) {
      case 'function':     checkParamsAndBody('Function',     m.name, m.location, m.params, m.body, out); break;
      case 'event':        checkParamsAndBody('Event',        m.name, m.location, m.params, m.body, out); break;
      case 'construction': checkParamsAndBody('Construction', '(construction)', m.location, [], m.body, out); break;
      default: break;
    }
  }
}

// ─── String distance for "did you mean" ────────────────────────────────────
function closestMatch(target: string, candidates: string[]): string | undefined {
  if (candidates.length === 0 || !target) { return undefined; }
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(target, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  // Cap suggestions at distance ≤ 2 (or ≤ ⌈len/3⌉ for longer strings) so we don't
  // suggest wildly unrelated names.
  const cutoff = Math.max(2, Math.ceil(target.length / 3));
  return bestDist <= cutoff ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) { return n; }
  if (n === 0) { return m; }
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) { dp[j] = j; }
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}
