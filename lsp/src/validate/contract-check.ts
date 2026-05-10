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
type Target = 'class' | 'variable' | 'component' | 'function' | 'event' | 'construction' | 'widget' | 'macro' | 'defaults' | 'settings' | 'param';

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
    case 'settings':     return 'settings block';
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
    case 'settings':     return 'settings';
  }
}

// ─── Decorator target bitmasks ──────────────────────────────────────────────
//
// Multi-target decorators (`@deprecated`, `@tooltip`, `@meta`, …) need a
// concise way to express "valid on var, function, event, macro" without
// a separate catalog per target. Each mask bit corresponds to one
// declaration target.
const TARGET_VAR             = 1 << 0;
const TARGET_FN              = 1 << 1;
const TARGET_EVT             = 1 << 2;
const TARGET_MAC             = 1 << 3;
const TARGET_PARAM           = 1 << 4;  // function/event/macro parameter pins
const TARGET_FN_LIKE         = TARGET_FN | TARGET_EVT | TARGET_MAC;     // share FKismetUserDeclaredFunctionMetadata
const TARGET_ALL_DECLS       = TARGET_VAR | TARGET_FN_LIKE;
const TARGET_ALL_DECLS_PARAM = TARGET_ALL_DECLS | TARGET_PARAM;

function targetToMask(t: Target): number {
  switch (t) {
    case 'variable': return TARGET_VAR;
    case 'function': return TARGET_FN;
    case 'event':    return TARGET_EVT;
    case 'macro':    return TARGET_MAC;
    case 'param':    return TARGET_PARAM;
    default:         return 0;
  }
}

function targetMaskToList(mask: number): string {
  const parts: string[] = [];
  if (mask & TARGET_VAR)   { parts.push('var'); }
  if (mask & TARGET_FN)    { parts.push('function'); }
  if (mask & TARGET_EVT)   { parts.push('event'); }
  if (mask & TARGET_MAC)   { parts.push('macro'); }
  if (mask & TARGET_PARAM) { parts.push('parameter'); }
  return parts.join(', ');
}

// ─── Decorator catalog ──────────────────────────────────────────────────────
//
// Each entry maps a decorator name to the set of targets that accept it.
// Mappings to BP-side CPF flags / metadata keys live in the C++ appliers
// (BacGenVariable for `var`; BacGenFunction for the rest); the validator
// here only checks shape (target + arg count + arg shape).
interface DecoratorEntry { name: string; targetMask: number; }

const ZERO_ARG_DECORATORS: DecoratorEntry[] = [
  // Variable-only:
  { name: 'editable',                          targetMask: TARGET_VAR },
  { name: 'readonly',                          targetMask: TARGET_VAR },
  { name: 'expose_on_spawn',                   targetMask: TARGET_VAR },
  { name: 'private',                           targetMask: TARGET_VAR },
  { name: 'interp',                            targetMask: TARGET_VAR },
  { name: 'config',                            targetMask: TARGET_VAR },
  { name: 'transient',                         targetMask: TARGET_VAR },
  { name: 'savegame',                          targetMask: TARGET_VAR },
  { name: 'advanced_display',                  targetMask: TARGET_VAR },
  // Function-only (UFunction ExtraFlags bits):
  { name: 'const',                             targetMask: TARGET_FN },
  { name: 'exec',                              targetMask: TARGET_FN },
  // Function + event + macro (FKismetUserDeclaredFunctionMetadata bool fields):
  { name: 'thread_safe',                       targetMask: TARGET_FN_LIKE },
  { name: 'unsafe_during_actor_construction',  targetMask: TARGET_FN_LIKE },
  { name: 'call_in_editor',                    targetMask: TARGET_FN_LIKE },
  // Universal (different storage per target — the appliers route correctly):
  { name: 'deprecated',                        targetMask: TARGET_ALL_DECLS },
];

const STRING_META_DECORATORS: DecoratorEntry[] = [
  { name: 'tooltip',             targetMask: TARGET_ALL_DECLS },
  { name: 'deprecation_message', targetMask: TARGET_ALL_DECLS },
  { name: 'category',            targetMask: TARGET_ALL_DECLS },
  { name: 'keywords',            targetMask: TARGET_FN_LIKE },
  { name: 'compact_node_title',  targetMask: TARGET_FN_LIKE },
];

// `ELifetimeCondition` enum values (engine `CoreNetTypes.h`) with the
// `COND_` prefix stripped. Hidden values (`Dynamic`, `NetGroup`, `Max`)
// excluded — they aren't user-selectable in the BP UI.
const REPLICATION_CONDITIONS = [
  'None', 'InitialOnly', 'OwnerOnly', 'SkipOwner', 'SimulatedOnly',
  'AutonomousOnly', 'SimulatedOrPhysics', 'InitialOrOwner', 'Custom',
  'ReplayOrOwner', 'ReplayOnly', 'SimulatedOnlyNoReplay',
  'SimulatedOrPhysicsNoReplay', 'SkipReplay', 'Never',
];
function isKnownReplicationCondition(name: string): boolean {
  return REPLICATION_CONDITIONS.includes(name);
}

const ACCESS_SPECIFIERS = ['public', 'protected', 'private'];
function isKnownAccessSpecifier(name: string): boolean {
  return ACCESS_SPECIFIERS.includes(name);
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
  const targetBit = targetToMask(target);

  // ─── Zero-arg flag decorators (catalog dispatch) ───────────────────────
  for (const entry of ZERO_ARG_DECORATORS) {
    if (d.name === entry.name) {
      if (!(entry.targetMask & targetBit)) {
        emitWrongTarget(out, d, target, targetMaskToList(entry.targetMask));
        return;
      }
      if (d.args.length !== 0) { emitBadArity(out, d, 0, d.args.length); }
      return;
    }
  }

  // ─── One-positional-string-lit metadata decorators ─────────────────────
  for (const entry of STRING_META_DECORATORS) {
    if (d.name === entry.name) {
      if (!(entry.targetMask & targetBit)) {
        emitWrongTarget(out, d, target, targetMaskToList(entry.targetMask));
        return;
      }
      if (d.args.length !== 1) { emitBadArity(out, d, 1, d.args.length); return; }
      if (d.args[0].name) {
        out.error(`Decorator @${d.name} expects a positional argument, not named '${d.args[0].name}'.`,
          d.location, 'BAC2103');
      }
      if (!isStringLit(d.args[0].value)) {
        out.error(`Decorator @${d.name} expects a string literal argument.`, d.location, 'BAC2103');
      }
      return;
    }
  }

  switch (d.name) {
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

    // `@display("Original Name")` — preserves a BP-side name that wasn't a
    // valid `.bac` identifier (illegal chars stripped, or keyword-collision
    // suffix). Allowed on var | function | event | macro | param. Round-trip
    // targets: variable's MetaDataArray["DisplayName"] / entry node's
    // MetaData["DisplayName"] / live `UEdGraphPin::PinFriendlyName` for
    // params.
    case 'display': {
      const allowedMask = TARGET_ALL_DECLS_PARAM;
      if (!(allowedMask & targetBit)) {
        emitWrongTarget(out, d, target, targetMaskToList(allowedMask));
        return;
      }
      if (d.args.length !== 1) { emitBadArity(out, d, 1, d.args.length); return; }
      if (d.args[0].name) {
        out.error(`Decorator @display expects a positional argument, not named '${d.args[0].name}'.`,
          d.location, 'BAC2103');
      }
      if (!isStringLit(d.args[0].value)) {
        out.error('Decorator @display expects a string literal argument.', d.location, 'BAC2103');
      }
      return;
    }

    // `@access(public | protected | private)` — function-level access
    // specifier. Sets one of `FUNC_Public`/`FUNC_Protected`/`FUNC_Private`
    // on the entry node's ExtraFlags. Default (no decorator) = public.
    case 'access': {
      if (target !== 'function') { emitWrongTarget(out, d, target, 'function'); return; }
      if (d.args.length !== 1 || d.args[0].name) {
        out.error('@access expects exactly one positional argument.', d.location, 'BAC2107');
        return;
      }
      const v = d.args[0].value;
      if (!v || v.kind !== 'ident' || !isKnownAccessSpecifier(v.name)) {
        out.error('@access expects one of: public, protected, private.', d.location, 'BAC2108');
      }
      return;
    }

    // `@meta(Key="value", Other="other")` — escape hatch for any UE metadata
    // key not promoted to a first-class decorator. Each arg is named (the
    // key); each value is a string literal. Allowed on var | function-like.
    case 'meta': {
      const allowedMask = TARGET_ALL_DECLS;
      if (!(allowedMask & targetBit)) {
        emitWrongTarget(out, d, target, targetMaskToList(allowedMask));
        return;
      }
      if (d.args.length === 0) {
        out.error('Decorator @meta expects at least one Key="value" pair.', d.location, 'BAC2102');
        return;
      }
      for (const arg of d.args) {
        if (!arg.name) {
          out.error('Decorator @meta expects named arguments (Key="value").', d.location, 'BAC2103');
          continue;
        }
        if (!isStringLit(arg.value)) {
          out.error(`Decorator @meta value for '${arg.name}' must be a string literal.`,
            d.location, 'BAC2103');
        }
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
        } else if (arg.name === 'condition') {
          // Identifier (no `COND_` prefix) drawn from `ELifetimeCondition`.
          // Stored on `FBPVariableDescription::ReplicationCondition` (a
          // dedicated enum field, not a metadata key).
          if (!arg.value || arg.value.kind !== 'ident' || !isKnownReplicationCondition(arg.value.name)) {
            out.error(
              '@replicated condition expects one of: None, InitialOnly, OwnerOnly, '
              + 'SkipOwner, SimulatedOnly, AutonomousOnly, SimulatedOrPhysics, '
              + 'InitialOrOwner, Custom, ReplayOrOwner, ReplayOnly, '
              + 'SimulatedOnlyNoReplay, SimulatedOrPhysicsNoReplay, SkipReplay, Never.',
              d.location, 'BAC2108');
          }
        } else {
          emitUnknownArg(out, d, arg.name ?? '', 'repnotify, condition');
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
  for (const m of cls.members) {
    if (m.kind !== 'defaults') { continue; }
    for (const a of m.assignments) {
      if (a.name === 'bReplicates' && a.value && a.value.kind === 'bool_lit' && a.value.value) {
        return true;
      }
    }
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
        message:  `@${d.name} implies the class must replicate, but '${cls.name}' does not set \`bReplicates = true\` in its \`defaults { … }\` block.`,
        hint:     'Add `bReplicates = true` to the `defaults { … }` block of the class.',
        fixes:    ['add `bReplicates = true` to defaults'],
      });
    }
  }
}
