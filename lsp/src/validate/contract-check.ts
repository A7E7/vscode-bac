// 1:1 port of BacContractCheck.cpp.
//
// Diagnostic codes BAC2100–BAC2199 are wire-stable across both implementations.
// The TS port runs at keystroke time inside the LSP; the C++ port runs as part
// of the `bac.lint` UE exec command on save (which also runs the engine-coupled
// passes the TS side can't do).

import { BacDiagnostics } from '../script/diagnostics';
import * as ast from '../script/ast';

export function runContractCheck(scriptAst: ast.BacScriptAst, out: BacDiagnostics): void {
  const cls = scriptAst.class;
  if (!cls) { return; }

  // Class-level decorators.
  for (const d of cls.decorators) { validateDecorator(d, 'class', out); }

  // Per-member.
  for (const m of cls.members) {
    const target = memberToTarget(m.kind);
    for (const d of m.decorators) { validateDecorator(d, target, out); }

    if (m.kind === 'function') {
      for (const p of m.params) {
        for (const d of p.decorators) { validateDecorator(d, 'param', out); }
      }
      checkFunctionContract(m, out);
    } else if (m.kind === 'event') {
      for (const p of m.params) {
        for (const d of p.decorators) { validateDecorator(d, 'param', out); }
      }
      // Events may be latent — no await contract check.
    }
  }

  // Cross-cutting: replication consistency.
  checkReplicationConsistency(cls, out);
}

// ─── Decorator target taxonomy ──────────────────────────────────────────────
type Target = 'class' | 'variable' | 'component' | 'function' | 'event' | 'construction' | 'widget' | 'macro' | 'defaults' | 'param';

function targetName(t: Target): string {
  switch (t) {
    case 'class':        return 'class';
    case 'variable':     return 'var';
    case 'component':    return 'component';
    case 'function':     return 'function';
    case 'event':        return 'event';
    case 'construction': return 'construction block';
    case 'widget':       return 'widget';
    case 'macro':        return 'macro';
    case 'defaults':     return 'defaults block';
    case 'param':        return 'parameter';
  }
}

function memberToTarget(k: ast.BacMember['kind']): Target {
  switch (k) {
    case 'variable':     return 'variable';
    case 'component':    return 'component';
    case 'function':     return 'function';
    case 'event':        return 'event';
    case 'construction': return 'construction';
    case 'widget':       return 'widget';
    case 'macro':        return 'macro';
    case 'defaults':     return 'defaults';
  }
}

// ─── Tiny expr-kind helpers ─────────────────────────────────────────────────
function isStringLit(e: ast.BacExpr | undefined): boolean { return !!e && e.kind === 'string_lit'; }
function isBoolLit  (e: ast.BacExpr | undefined): boolean { return !!e && e.kind === 'bool_lit'; }

function isIdentifierMatching(e: ast.BacExpr | undefined, ...allowed: string[]): boolean {
  if (!e || e.kind !== 'ident') { return false; }
  return allowed.includes(e.name);
}

// ─── Decorator validation ──────────────────────────────────────────────────
function emitWrongTarget(out: BacDiagnostics, d: ast.BacDecorator, t: Target, allowed: string): void {
  out.error(`Decorator @${d.name} is not allowed on ${targetName(t)}; valid on ${allowed}.`,
    d.location, 'BAC2101');
}
function emitBadArity(out: BacDiagnostics, d: ast.BacDecorator, expected: number, actual: number): void {
  out.error(`Decorator @${d.name} expects ${expected} argument(s) but got ${actual}.`,
    d.location, 'BAC2102');
}
function emitUnknownArg(out: BacDiagnostics, d: ast.BacDecorator, argName: string, allowedList: string): void {
  out.error(`Decorator @${d.name} has unknown argument '${argName}'. Valid: ${allowedList}.`,
    d.location, 'BAC2105');
}

function validateDecorator(d: ast.BacDecorator, target: Target, out: BacDiagnostics): void {
  switch (d.name) {
    case 'editable':
    case 'readonly':
    case 'bind_widget':
    case 'bind_widget_optional': {
      if (target !== 'variable') { emitWrongTarget(out, d, target, 'var'); return; }
      if (d.args.length !== 0) { emitBadArity(out, d, 0, d.args.length); }
      return;
    }
    case 'blueprintable':
    case 'macro_library': {
      if (target !== 'class') { emitWrongTarget(out, d, target, 'class'); return; }
      if (d.args.length !== 0) { emitBadArity(out, d, 0, d.args.length); }
      return;
    }
    case 'category': {
      if (target !== 'variable' && target !== 'function' && target !== 'event') {
        emitWrongTarget(out, d, target, 'var, function, event');
        return;
      }
      if (d.args.length !== 1) { emitBadArity(out, d, 1, d.args.length); return; }
      if (d.args[0].name) {
        out.error(`Decorator @category expects a positional argument, not named '${d.args[0].name}'.`,
          d.location, 'BAC2103');
      }
      if (!isStringLit(d.args[0].value)) {
        out.error('Decorator @category expects a string literal argument.', d.location, 'BAC2103');
      }
      return;
    }
    case 'replicated': {
      if (target !== 'variable') { emitWrongTarget(out, d, target, 'var'); return; }
      for (const arg of d.args) {
        if (arg.name === 'repnotify') {
          if (!arg.value || arg.value.kind !== 'ident') {
            out.error('@replicated repnotify expects a function name (identifier).',
              d.location, 'BAC2104');
          }
        } else {
          emitUnknownArg(out, d, arg.name ?? '', 'repnotify');
        }
      }
      return;
    }
    case 'replicated_default': {
      if (target !== 'class') { emitWrongTarget(out, d, target, 'class'); return; }
      for (const arg of d.args) {
        if (arg.name !== 'replicates' && arg.name !== 'alwaysRelevant') {
          emitUnknownArg(out, d, arg.name ?? '', 'replicates, alwaysRelevant');
          continue;
        }
        if (!isBoolLit(arg.value)) {
          out.error(`@replicated_default '${arg.name}' expects a bool literal.`,
            d.location, 'BAC2106');
        }
      }
      return;
    }
    case 'event': {
      if (target !== 'event') { emitWrongTarget(out, d, target, 'event'); return; }
      for (const arg of d.args) {
        if (arg.name === 'runson') {
          if (!isIdentifierMatching(arg.value, 'server', 'client', 'owner', 'multicast')) {
            out.error('@event runson expects one of: server, client, owner, multicast.',
              d.location, 'BAC2108');
          }
        } else if (arg.name === 'reliable') {
          if (!isBoolLit(arg.value)) {
            out.error('@event reliable expects a bool literal.', d.location, 'BAC2106');
          }
        } else {
          emitUnknownArg(out, d, arg.name ?? '', 'runson, reliable');
        }
      }
      return;
    }
    case 'runson': {
      if (target !== 'event') { emitWrongTarget(out, d, target, 'event'); return; }
      if (d.args.length !== 1 || d.args[0].name) {
        out.error('@runson expects exactly one positional argument.', d.location, 'BAC2107');
        return;
      }
      if (!isIdentifierMatching(d.args[0].value, 'server', 'client', 'owner', 'multicast')) {
        out.error('@runson expects one of: server, client, owner, multicast.',
          d.location, 'BAC2108');
      }
      return;
    }
    default: {
      // Unknown decorator: warn rather than error so AI workflow doesn't choke.
      out.warning(`Unknown decorator @${d.name}; ignored.`, d.location, 'BAC2199');
    }
  }
}

// ─── Await-presence walker ─────────────────────────────────────────────────
function findAwait(node: ast.BacStmt | ast.BacExpr | undefined): { found: boolean; location?: { line: number; column: number; offset: number } } {
  if (!node) { return { found: false }; }
  // Type-narrowed walker. We stop as soon as we find one.
  let result: { found: boolean; location?: { line: number; column: number; offset: number } } = { found: false };

  const visitExpr = (e: ast.BacExpr | undefined): void => {
    if (!e || result.found) { return; }
    if (e.kind === 'await') { result = { found: true, location: e.location }; return; }
    switch (e.kind) {
      case 'member_access': visitExpr(e.target); return;
      case 'index':         visitExpr(e.target); visitExpr(e.index); return;
      case 'call':
      case 'generic_call':  visitExpr(e.callee); for (const a of e.args) { visitExpr(a.value); } return;
      case 'binary':        visitExpr(e.left); visitExpr(e.right); return;
      case 'unary':         visitExpr(e.operand); return;
      case 'cast':          visitExpr(e.source); return;
      default: return;
    }
  };

  const visitStmt = (s: ast.BacStmt | undefined): void => {
    if (!s || result.found) { return; }
    switch (s.kind) {
      case 'block':    for (const inner of s.statements) { visitStmt(inner); } return;
      case 'expr':     visitExpr(s.expr); return;
      case 'var_decl': visitExpr(s.initializer); return;
      case 'if':       visitExpr(s.condition); visitStmt(s.then); visitStmt(s.else); return;
      case 'for':      visitExpr(s.iterable); visitStmt(s.body); return;
      case 'while':    visitExpr(s.condition); visitStmt(s.body); return;
      case 'return':   visitExpr(s.value); return;
      case 'assign':   visitExpr(s.target); visitExpr(s.value); return;
      default: return;
    }
  };

  if ('statements' in node || 'expr' in node || 'condition' in node || 'iterable' in node) {
    visitStmt(node as ast.BacStmt);
  } else {
    visitExpr(node as ast.BacExpr);
  }
  return result;
}

function checkFunctionContract(f: ast.BacFunctionDecl, out: BacDiagnostics): void {
  const find = findAwait(f.body);
  if (!find.found) { return; }
  if (f.isPure) {
    out.items.push({
      severity: 'error',
      code:     'BAC2110',
      location: f.location,
      message:  `Pure function '${f.name}' may not contain 'await' (pure functions cannot pause).`,
      notes:    find.location ? [{ message: "first 'await' here", location: find.location }] : [],
      hint:     "Remove 'pure', or remove the 'await'.",
    });
    return;
  }
  out.items.push({
    severity: 'error',
    code:     'BAC2111',
    location: f.location,
    message:  `Function '${f.name}' contains 'await' but is declared 'function'. Blueprint functions are synchronous; latent calls require an 'event'.`,
    notes:    find.location ? [{ message: "first 'await' here", location: find.location }] : [],
    hint:     `Change 'function ${f.name}' to 'event ${f.name}', or remove the await.`,
    fixes:    [`replace \`function ${f.name}(\` with \`event ${f.name}(\``],
  });
}

// ─── Class-level replication consistency ───────────────────────────────────
function classDeclaresReplication(cls: ast.BacClassDecl): boolean {
  for (const d of cls.decorators) {
    if (d.name !== 'replicated_default') { continue; }
    let replicates = true;
    for (const arg of d.args) {
      if (arg.name === 'replicates' && arg.value && arg.value.kind === 'bool_lit') {
        replicates = arg.value.value;
      }
    }
    if (replicates) { return true; }
  }
  return false;
}

function decoratorImpliesReplication(d: ast.BacDecorator): boolean {
  if (d.name === 'replicated' || d.name === 'runson') { return true; }
  if (d.name === 'event') {
    for (const a of d.args) { if (a.name === 'runson') { return true; } }
  }
  return false;
}

function checkReplicationConsistency(cls: ast.BacClassDecl, out: BacDiagnostics): void {
  if (classDeclaresReplication(cls)) { return; }
  for (const m of cls.members) {
    for (const d of m.decorators) {
      if (!decoratorImpliesReplication(d)) { continue; }
      out.items.push({
        severity: 'error',
        code:     'BAC2240',
        location: d.location,
        message:  `@${d.name} implies the class must replicate, but '${cls.name}' has no @replicated_default(replicates=true).`,
        hint:     `Add \`@replicated_default(replicates=true)\` above \`class ${cls.name}\`.`,
        fixes:    [`add \`@replicated_default(replicates=true)\` before \`class ${cls.name}\``],
      });
    }
  }
}
