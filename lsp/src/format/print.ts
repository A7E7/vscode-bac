// Prettier-doc printer for `.bac`.
//
// Style is opinionated and locked (no config knobs):
//
//   • 2-space indent, 80-char print width.
//   • No semicolons (BAC has none).
//   • Decorators on their own lines above the member they decorate.
//   • One blank line between top-level members.
//   • Imports grouped at top, source-path alphabetical within a group.
//   • Trailing commas on multi-line argument and parameter lists.
//   • `if/else if/else` chains stay on the same line as the closing `}`.
//   • Calls / generic calls / binary chains use Prettier's group-fitting:
//     fit on one line when they can; otherwise break with one piece per line.
//
// This module is pure: `(BacFormatRoot) → Doc`. It does not call into
// Prettier's `format` itself — the public `format.ts` module wraps it.

import { doc as PrettierDoc } from 'prettier';
import * as ast from '../script/ast';
import { BacFormatRoot, BacComment } from './parser';

const { group, indent, join, line, softline, hardline, ifBreak } = PrettierDoc.builders;
type Doc = PrettierDoc.builders.Doc;

// ─── Public entry point ─────────────────────────────────────────────────

export function printBacRoot(root: BacFormatRoot): Doc {
  const cursor = new CommentCursor(root.comments);
  const parts: Doc[] = [];

  // Imports — alphabetize by source path, blank line between groups.
  if (root.ast.imports.length > 0) {
    const imports = sortImports(root.ast.imports);
    let lastSource = '';
    for (let i = 0; i < imports.length; i++) {
      const imp = imports[i];
      // Flush comments before this import (leading comments on the import
      // block float up; we attach to the first import's offset).
      if (i === 0) { parts.push(...cursor.flushBefore(imp.location.offset)); }
      if (i > 0 && imp.fromPath !== lastSource) { parts.push(hardline); }
      parts.push(printImport(imp));
      parts.push(hardline);
      lastSource = imp.fromPath;
    }
    parts.push(hardline);
  }

  // Top-level decl — class / struct / asset / table. Exactly one is
  // populated by the parser; we route to the matching printer so non-
  // class documents don't get their body dropped.
  if (root.ast.class) {
    parts.push(...cursor.flushBefore(root.ast.class.location.offset));
    parts.push(printClass(root.ast.class, cursor));
    parts.push(hardline);
  } else if (root.ast.struct) {
    parts.push(...cursor.flushBefore(root.ast.struct.location.offset));
    parts.push(printStruct(root.ast.struct));
    parts.push(hardline);
  } else if (root.ast.asset) {
    parts.push(...cursor.flushBefore(root.ast.asset.location.offset));
    parts.push(printAsset(root.ast.asset));
    parts.push(hardline);
  } else if (root.ast.table) {
    parts.push(...cursor.flushBefore(root.ast.table.location.offset));
    parts.push(printTable(root.ast.table));
    parts.push(hardline);
  }

  // Trailing comments after the last node.
  parts.push(...cursor.flushRest());

  return parts;
}

// ─── Imports ────────────────────────────────────────────────────────────

function sortImports(imports: ast.BacImport[]): ast.BacImport[] {
  // Stable sort by fromPath; preserves authoring order within the same source.
  return [...imports].sort((a, b) => a.fromPath.localeCompare(b.fromPath));
}

function printImport(imp: ast.BacImport): Doc {
  // `import { A, B } from "path"` — names sorted, no trailing comma.
  const sortedNames = [...imp.names].sort();
  const namesPart   = group([
    '{',
    indent([
      line,
      join([',', line], sortedNames),
    ]),
    line,
    '}',
  ]);
  return ['import ', namesPart, ' from "', imp.fromPath, '"'];
}

// ─── Class ──────────────────────────────────────────────────────────────

function printClass(cls: ast.BacClassDecl, cursor: CommentCursor): Doc {
  const parts: Doc[] = [];
  for (const d of cls.decorators) {
    parts.push(printDecorator(d));
    parts.push(hardline);
  }
  parts.push('class ', cls.name);
  if (cls.parentTypeName) {
    parts.push(' : ', cls.parentTypeName);
    if (cls.parentQualifiedPath) { parts.push('@', cls.parentQualifiedPath); }
  }
  if (cls.implementedInterfaces.length > 0) {
    const paths = cls.interfaceQualifiedPaths ?? [];
    parts.push(' implements ', cls.implementedInterfaces.map((iface, i) => {
      const qp = paths[i];
      return qp ? `${iface}@${qp}` : iface;
    }).join(', '));
  }
  parts.push(' {');
  // Members.
  if (cls.members.length === 0) {
    parts.push('}');
    return parts;
  }
  const memberParts: Doc[] = [];
  for (let i = 0; i < cls.members.length; i++) {
    const m    = cls.members[i];
    const next = cls.members[i + 1];
    memberParts.push(...cursor.flushBefore(m.location.offset));
    memberParts.push(printMember(m, cursor));
    if (next) {
      memberParts.push(hardline, hardline);
    } else {
      memberParts.push(hardline);
    }
  }
  parts.push(indent([hardline, ...memberParts]));
  parts.push('}');
  return parts;
}

// ─── Struct / Asset / Table ─────────────────────────────────────────────

function printStruct(s: ast.BacStructDecl): Doc {
  const parts: Doc[] = [];
  for (const d of s.decorators) { parts.push(printDecorator(d), hardline); }
  parts.push('struct ', s.name, ' {');
  if (s.fields.length === 0) { parts.push('}'); return parts; }
  const body: Doc[] = [];
  for (let i = 0; i < s.fields.length; i++) {
    body.push(printVariable(s.fields[i]));
    body.push(i === s.fields.length - 1 ? hardline : hardline);
  }
  parts.push(indent([hardline, ...body]));
  parts.push('}');
  return parts;
}

function printAsset(a: ast.BacAssetDecl): Doc {
  const parts: Doc[] = [];
  for (const d of a.decorators) { parts.push(printDecorator(d), hardline); }
  parts.push('asset ', a.name, ' : ', a.parentTypeName);
  if (a.parentQualifiedPath) { parts.push('@', a.parentQualifiedPath); }
  parts.push(' {');
  if (a.assignments.length === 0) { parts.push('}'); return parts; }
  const body: Doc[] = [];
  for (let i = 0; i < a.assignments.length; i++) {
    const asn = a.assignments[i];
    body.push(asn.name, ' = ', printExpr(asn.value), hardline);
  }
  parts.push(indent([hardline, ...body]));
  parts.push('}');
  return parts;
}

function printTable(t: ast.BacTableDecl): Doc {
  const parts: Doc[] = [];
  for (const d of t.decorators) { parts.push(printDecorator(d), hardline); }
  parts.push('table ', t.name, ' : ', t.rowStructName, ' {');
  if (t.rows.length === 0) { parts.push('}'); return parts; }
  const body: Doc[] = [];
  for (let i = 0; i < t.rows.length; i++) {
    const r = t.rows[i];
    body.push('row "', r.name, '" {');
    if (r.assignments.length > 0) {
      const inner: Doc[] = [];
      for (const asn of r.assignments) {
        inner.push(asn.name, ' = ', printExpr(asn.value), hardline);
      }
      body.push(indent([hardline, ...inner]), '}');
    } else {
      body.push('}');
    }
    if (i < t.rows.length - 1) { body.push(hardline, hardline); }
    else { body.push(hardline); }
  }
  parts.push(indent([hardline, ...body]));
  parts.push('}');
  return parts;
}

// ─── Decorators ─────────────────────────────────────────────────────────

function printDecorator(d: ast.BacDecorator): Doc {
  if (d.args.length === 0) { return ['@', d.name]; }
  return [
    '@',
    d.name,
    '(',
    join(', ', d.args.map(printDecoratorArg)),
    ')',
  ];
}

function printDecoratorArg(a: ast.BacDecoratorArg): Doc {
  if (a.name) { return [a.name, ' = ', printExpr(a.value)]; }
  return printExpr(a.value);
}

// ─── Members ────────────────────────────────────────────────────────────

function printMember(m: ast.BacMember, cursor: CommentCursor): Doc {
  const parts: Doc[] = [];
  for (const d of m.decorators) {
    parts.push(printDecorator(d));
    parts.push(hardline);
  }
  switch (m.kind) {
    case 'variable':     parts.push(printVariable(m));     break;
    case 'component':    parts.push(printComponent(m, cursor)); break;
    case 'function':     parts.push(printFunction(m, cursor));  break;
    case 'event':        parts.push(printEvent(m, cursor));     break;
    case 'construction': parts.push(printConstruction(m, cursor)); break;
    case 'widget':       parts.push(printWidget(m, cursor, /*nested=*/false)); break;
  }
  return parts;
}

// `widget Root: ... { … }` (top-level form) and the keyword-less child
// form (`Name: Type { … }`). The body recursively contains static
// assignments (`Name = expr`), bindings (`Name => Func`), and child
// widgets.
function printWidget(w: ast.BacWidgetDecl, cursor: CommentCursor, nested: boolean): Doc {
  const head: Doc[] = [];
  if (!nested) { head.push('widget '); }
  head.push(w.name, ': ', printType(w.type));
  if (w.defaults.length === 0 && w.children.length === 0) { return head; }
  const body: Doc[] = [];
  for (let i = 0; i < w.defaults.length; i++) {
    const def = w.defaults[i];
    body.push(...cursor.flushBefore(def.location.offset));
    body.push(def.name, def.isBinding ? ' => ' : ' = ', printExpr(def.value));
    if (i < w.defaults.length - 1 || w.children.length > 0) { body.push(hardline); }
  }
  for (let i = 0; i < w.children.length; i++) {
    const child = w.children[i];
    body.push(...cursor.flushBefore(child.location.offset));
    body.push(printWidget(child, cursor, /*nested=*/true));
    if (i < w.children.length - 1) { body.push(hardline); }
  }
  head.push(' {');
  head.push(indent([hardline, ...body]));
  head.push(hardline, '}');
  return head;
}

function printVariable(m: ast.BacVariableDecl): Doc {
  const head: Doc[] = ['var ', m.name, ': ', printType(m.type)];
  if (m.initializer) { head.push(' = ', printExpr(m.initializer)); }
  return head;
}

function printComponent(m: ast.BacComponentDecl, cursor: CommentCursor): Doc {
  const head: Doc[] = ['component ', m.name, ': ', printType(m.type)];
  if (m.attachParent) { head.push(' attach ', m.attachParent); }
  if (m.defaults.length === 0) { return head; }
  // Block of `key = value` lines.
  const defaults: Doc[] = [];
  for (let i = 0; i < m.defaults.length; i++) {
    const def = m.defaults[i];
    defaults.push(...cursor.flushBefore(def.location.offset));
    defaults.push(def.name, ' = ', printExpr(def.value));
    if (i < m.defaults.length - 1) { defaults.push(hardline); }
  }
  head.push(' {');
  head.push(indent([hardline, ...defaults]));
  head.push(hardline, '}');
  return head;
}

function printFunction(m: ast.BacFunctionDecl, cursor: CommentCursor): Doc {
  const head: Doc[] = [];
  if (m.isPure) { head.push('pure '); }
  head.push('function ', m.name);
  head.push(printParamList(m.params));
  if (m.returnType) { head.push(': ', printType(m.returnType)); }
  if (m.interfaceImpl) { head.push(' implements ', m.interfaceImpl); }
  head.push(' ');
  head.push(printBlock(m.body, cursor));
  return head;
}

function printEvent(m: ast.BacEventDecl, cursor: CommentCursor): Doc {
  return [
    'event ', m.name,
    printParamList(m.params),
    ' ',
    printBlock(m.body, cursor),
  ];
}

function printConstruction(m: ast.BacConstructionDecl, cursor: CommentCursor): Doc {
  return ['construction ', printBlock(m.body, cursor)];
}

function printParamList(params: ast.BacParam[]): Doc {
  if (params.length === 0) { return '()'; }
  const items: Doc[] = params.map((p) => {
    const pd: Doc[] = [];
    for (const d of p.decorators) { pd.push(printDecorator(d), ' '); }
    pd.push(p.name, ': ', printType(p.type));
    if (p.default) { pd.push(' = ', printExpr(p.default)); }
    return pd;
  });
  return group([
    '(',
    indent([softline, join([',', line], items), ifBreak(',', '')]),
    softline,
    ')',
  ]);
}

// ─── Statements ─────────────────────────────────────────────────────────

function printBlock(b: ast.BacBlockStmt, cursor: CommentCursor): Doc {
  if (b.statements.length === 0) {
    // Flush any comments inside an otherwise-empty block.
    const inner = cursor.flushBefore(b.location.offset + 1);
    if (inner.length === 0) { return '{}'; }
    return ['{', indent([hardline, ...inner]), hardline, '}'];
  }
  const parts: Doc[] = [];
  for (let i = 0; i < b.statements.length; i++) {
    const s = b.statements[i];
    parts.push(...cursor.flushBefore(s.location.offset));
    parts.push(printStmt(s, cursor));
    if (i < b.statements.length - 1) { parts.push(hardline); }
  }
  return ['{', indent([hardline, ...parts]), hardline, '}'];
}

function printStmt(s: ast.BacStmt, cursor: CommentCursor): Doc {
  switch (s.kind) {
    case 'block':    return printBlock(s, cursor);
    case 'expr':     return printExpr(s.expr);
    case 'var_decl': return printVarDeclStmt(s);
    case 'if':       return printIfStmt(s, cursor);
    case 'for':      return printForStmt(s, cursor);
    case 'while':    return printWhileStmt(s, cursor);
    case 'return':   return s.value ? ['return ', printExpr(s.value)] : 'return';
    case 'break':    return 'break';
    case 'continue': return 'continue';
    case 'reset':    return ['reset ', s.targetLabel];
    case 'assign':   return [printExpr(s.target), ' ', assignOp(s.op), ' ', printExpr(s.value)];
  }
}

function printVarDeclStmt(s: ast.BacVarDeclStmt): Doc {
  const head: Doc[] = [s.isMutable ? 'var ' : 'let ', s.name];
  if (s.type)        { head.push(': ', printType(s.type)); }
  if (s.initializer) { head.push(' = ', printExpr(s.initializer)); }
  return head;
}

function printIfStmt(s: ast.BacIfStmt, cursor: CommentCursor): Doc {
  const cond: Doc = s.letName
    ? ['let ', s.letName, ' = ', printExpr(s.condition)]
    : printExpr(s.condition);
  const parts: Doc[] = ['if (', cond, ') ', printBlock(s.then, cursor)];
  if (s.else) {
    parts.push(' else ');
    if (s.else.kind === 'if')          { parts.push(printIfStmt(s.else, cursor)); }
    else if (s.else.kind === 'block')  { parts.push(printBlock(s.else, cursor)); }
    else                                { parts.push('{ ', printStmt(s.else, cursor), ' }'); }
  }
  return parts;
}

function printForStmt(s: ast.BacForStmt, cursor: CommentCursor): Doc {
  const binding: Doc[] = [s.bindingName];
  if (s.bindingType) { binding.push(': ', printType(s.bindingType)); }
  return [
    'for (', binding, ' in ', printExpr(s.iterable), ') ',
    printBlock(s.body, cursor),
  ];
}

function printWhileStmt(s: ast.BacWhileStmt, cursor: CommentCursor): Doc {
  return ['while (', printExpr(s.condition), ') ', printBlock(s.body, cursor)];
}

function assignOp(op: ast.BacAssignOp): string {
  switch (op) {
    case 'assign':     return '=';
    case 'plus_eq':    return '+=';
    case 'minus_eq':   return '-=';
    case 'star_eq':    return '*=';
    case 'slash_eq':   return '/=';
    case 'percent_eq': return '%=';
  }
}

// ─── Expressions ────────────────────────────────────────────────────────

function printExpr(e: ast.BacExpr): Doc {
  switch (e.kind) {
    case 'int_lit':       return String(e.value);
    case 'float_lit':     return formatFloat(e.value);
    case 'string_lit':    return ['"', e.value, '"'];
    case 'bool_lit':      return e.value ? 'true' : 'false';
    case 'none_lit':      return 'none';
    case 'this':          return 'this';
    case 'super':         return 'super';
    case 'ident':         return e.name;
    case 'asset':         return ['asset("', e.path, '")'];
    case 'default':       return ['default<', printType(e.typeArg), '>()'];
    case 'await':         return ['await ', printExpr(e.inner)];
    case 'unary':         return [unaryOp(e.op), printExpr(e.operand)];
    case 'cast':          return [printExpr(e.source), ' as ', printType(e.targetType)];
    case 'member_access': return [printExpr(e.target), e.separator, e.memberName];
    case 'index':         return [printExpr(e.target), '[', printExpr(e.index), ']'];
    case 'call':          return printCall(e);
    case 'generic_call':  return printGenericCall(e);
    case 'binary':        return printBinary(e);
  }
}

function unaryOp(op: ast.BacUnaryOp): string {
  return op === 'negate' ? '-' : '!';
}

function binaryOp(op: ast.BacBinaryOp): string {
  switch (op) {
    case 'add':    return '+';
    case 'sub':    return '-';
    case 'mul':    return '*';
    case 'div':    return '/';
    case 'mod':    return '%';
    case 'eq':     return '==';
    case 'not_eq': return '!=';
    case 'lt':     return '<';
    case 'gt':     return '>';
    case 'lt_eq':  return '<=';
    case 'gt_eq':  return '>=';
    case 'and':    return '&&';
    case 'or':     return '||';
  }
}

function printBinary(e: ast.BacBinaryExpr): Doc {
  // Group so Prettier breaks at the operator when the line is too long.
  return group([printExpr(e.left), ' ', binaryOp(e.op), line, printExpr(e.right)]);
}

function printCall(e: ast.BacCallExpr): Doc {
  return [printExpr(e.callee), printArgList(e.args)];
}

function printGenericCall(e: ast.BacGenericCallExpr): Doc {
  const typeArgs: Doc = ['<', join(', ', e.typeArgs.map(printType)), '>'];
  return [printExpr(e.callee), typeArgs, printArgList(e.args)];
}

function printArgList(args: ast.BacCallArg[]): Doc {
  if (args.length === 0) { return '()'; }
  const items: Doc[] = args.map((a) =>
    a.name ? [a.name, ' = ', printExpr(a.value)] : printExpr(a.value),
  );
  return group([
    '(',
    indent([softline, join([',', line], items), ifBreak(',', '')]),
    softline,
    ')',
  ]);
}

function formatFloat(v: number): string {
  // Always include a decimal point — `1.0` not `1`. Round-trips with the
  // lexer (which classifies `1` as int, `1.0` as float).
  if (Number.isInteger(v)) { return v.toFixed(1); }
  return String(v);
}

// ─── Types ──────────────────────────────────────────────────────────────

function printType(t: ast.BacTypeRef): Doc {
  let s: Doc = t.baseName;
  if (t.genericArgs.length > 0) {
    s = [s, '<', join(', ', t.genericArgs.map(printType)), '>'];
  }
  for (let i = 0; i < t.arrayDepth; i++) {
    s = [s, '[]'];
  }
  if (t.qualifiedPath) {
    s = [s, '@', t.qualifiedPath];
  }
  return s;
}

// ─── Comment cursor ─────────────────────────────────────────────────────

/**
 * Walks the comment list in source order. `flushBefore(offset)` returns and
 * consumes every comment whose `start` is less than `offset`, formatted with
 * appropriate trailing breaks. Standalone block comments and line comments
 * each get a `hardline` after; consecutive comments on the same line stay
 * grouped.
 */
class CommentCursor {
  private idx = 0;
  constructor(private readonly comments: BacComment[]) {}

  flushBefore(offset: number): Doc[] {
    const out: Doc[] = [];
    while (this.idx < this.comments.length && this.comments[this.idx].start < offset) {
      out.push(this.comments[this.idx].raw);
      out.push(hardline);
      this.idx++;
    }
    return out;
  }

  flushRest(): Doc[] {
    const out: Doc[] = [];
    while (this.idx < this.comments.length) {
      out.push(this.comments[this.idx].raw);
      out.push(hardline);
      this.idx++;
    }
    return out;
  }
}
