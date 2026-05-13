// 1:1 port of BacAst.h.
//
// In TypeScript we model the three parallel hierarchies (Expr, Stmt, Member)
// as discriminated unions on a `kind` tag. That gives narrowing in switch
// statements without RTTI, mirroring how the C++ code uses EBac{Expr,Stmt,
// Member}Kind + static_cast.

import { BacSourceLocation } from './diagnostics';

// ─── Operator enums ─────────────────────────────────────────────────────────
export type BacBinaryOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'
  | 'eq'  | 'not_eq' | 'lt' | 'gt' | 'lt_eq' | 'gt_eq'
  | 'and' | 'or';

export type BacUnaryOp = 'negate' | 'not';

export type BacAssignOp =
  | 'assign' | 'plus_eq' | 'minus_eq' | 'star_eq' | 'slash_eq' | 'percent_eq';

// ─── Type references ────────────────────────────────────────────────────────
export interface BacTypeRef {
  location:    BacSourceLocation;
  baseName:    string;             // "float", "Actor", "Set", "Map"
  genericArgs: BacTypeRef[];
  arrayDepth:  number;             // T[] -> 1, T[][] -> 2
}

// ─── Decorators ─────────────────────────────────────────────────────────────
export interface BacDecoratorArg {
  name?:  string;                  // empty if positional
  value:  BacExpr;
}

export interface BacDecorator {
  location: BacSourceLocation;
  name:     string;                // "editable", "category", "replicated", "event"
  args:     BacDecoratorArg[];
}

// ─── Expressions ────────────────────────────────────────────────────────────
export type BacExpr =
  | BacIntLit | BacFloatLit | BacStringLit | BacBoolLit | BacNoneLit
  | BacThisExpr | BacSuperExpr | BacIdentExpr
  | BacMemberAccessExpr | BacIndexExpr | BacCallExpr | BacGenericCallExpr
  | BacBinaryExpr | BacUnaryExpr | BacCastExpr | BacAssetExpr
  | BacDefaultExpr | BacAwaitExpr;

interface BacExprBase { location: BacSourceLocation }

export interface BacIntLit          extends BacExprBase { kind: 'int_lit';      value: bigint }
export interface BacFloatLit        extends BacExprBase { kind: 'float_lit';    value: number }
export interface BacStringLit       extends BacExprBase { kind: 'string_lit';   value: string } // raw between quotes; not de-escaped
export interface BacBoolLit         extends BacExprBase { kind: 'bool_lit';     value: boolean }
export interface BacNoneLit         extends BacExprBase { kind: 'none_lit'  }
export interface BacThisExpr        extends BacExprBase { kind: 'this'      }
export interface BacSuperExpr       extends BacExprBase { kind: 'super'     }
export interface BacIdentExpr       extends BacExprBase { kind: 'ident';        name: string }

export interface BacMemberAccessExpr extends BacExprBase {
  kind:       'member_access';
  target:     BacExpr;
  memberName: string;
}
export interface BacIndexExpr extends BacExprBase {
  kind:   'index';
  target: BacExpr;
  index:  BacExpr;
}

export interface BacCallArg {
  name?: string;                   // empty if positional
  value: BacExpr;
}

export interface BacCallExpr extends BacExprBase {
  kind:   'call';
  callee: BacExpr;
  args:   BacCallArg[];
}
export interface BacGenericCallExpr extends BacExprBase {
  kind:     'generic_call';
  callee:   BacExpr;
  typeArgs: BacTypeRef[];
  args:     BacCallArg[];
}

export interface BacBinaryExpr extends BacExprBase {
  kind:  'binary';
  op:    BacBinaryOp;
  left:  BacExpr;
  right: BacExpr;
}
export interface BacUnaryExpr extends BacExprBase {
  kind:    'unary';
  op:      BacUnaryOp;
  operand: BacExpr;
}
export interface BacCastExpr extends BacExprBase {
  kind:       'cast';
  source:     BacExpr;
  targetType: BacTypeRef;
}
export interface BacAssetExpr extends BacExprBase { kind: 'asset';   path: string }
export interface BacDefaultExpr extends BacExprBase {
  kind:    'default';
  typeArg: BacTypeRef;
}
export interface BacAwaitExpr extends BacExprBase { kind: 'await';   inner: BacExpr }

// ─── Statements ─────────────────────────────────────────────────────────────
export type BacStmt =
  | BacBlockStmt | BacExprStmt | BacVarDeclStmt
  | BacIfStmt    | BacForStmt  | BacWhileStmt
  | BacReturnStmt | BacBreakStmt | BacContinueStmt
  | BacAssignStmt;

interface BacStmtBase { location: BacSourceLocation }

export interface BacBlockStmt    extends BacStmtBase { kind: 'block';    statements: BacStmt[] }
export interface BacExprStmt     extends BacStmtBase { kind: 'expr';     expr: BacExpr }
export interface BacVarDeclStmt  extends BacStmtBase {
  kind:        'var_decl';
  isMutable:   boolean;            // var=true, let=false
  name:        string;
  type?:       BacTypeRef;         // optional, inferred if null
  initializer?: BacExpr;
}
export interface BacIfStmt extends BacStmtBase {
  kind:      'if';
  /** Empty for plain `if (cond)`; non-empty for `if (let Name = expr)`. */
  letName?:  string;
  condition: BacExpr;
  then:      BacBlockStmt;
  /** BlockStmt for `else { … }`; IfStmt for `else if (…) …`; undefined if no else. */
  else?:     BacStmt;
}
export interface BacForStmt extends BacStmtBase {
  kind:         'for';
  bindingName:  string;
  bindingType?: BacTypeRef;
  iterable:     BacExpr;
  body:         BacBlockStmt;
}
export interface BacWhileStmt extends BacStmtBase {
  kind:      'while';
  condition: BacExpr;
  body:      BacBlockStmt;
}
export interface BacReturnStmt   extends BacStmtBase { kind: 'return'; value?: BacExpr }
export interface BacBreakStmt    extends BacStmtBase { kind: 'break'    }
export interface BacContinueStmt extends BacStmtBase { kind: 'continue' }
export interface BacAssignStmt extends BacStmtBase {
  kind:   'assign';
  op:     BacAssignOp;
  target: BacExpr;
  value:  BacExpr;
}

// ─── Members ────────────────────────────────────────────────────────────────
export interface BacParam {
  name:        string;
  type:        BacTypeRef;
  default?:    BacExpr;
  decorators:  BacDecorator[];
  /** `ref` modifier — pin gets `CPF_ReferenceParm`. The BP "Pass-by-Reference"
   *  checkbox writes this. Pin direction stays as the function declares it. */
  bIsByRef?:   boolean;
  /** `const` modifier — pin gets `CPF_ConstParm`. The BP "Const" checkbox on
   *  a parameter writes this; signals the body must not mutate the value. */
  bIsConst?:   boolean;
}

export interface BacAssignment {
  name:     string;
  value:    BacExpr;
  location: BacSourceLocation;
  /** UMG widget property binding (`PropName => FuncName`). When true,
   *  `value` must be an identifier expression naming the BP function
   *  the property runtime-binds to. */
  isBinding?: boolean;
}

export type BacMember =
  | BacVariableDecl | BacComponentDecl | BacFunctionDecl
  | BacEventDecl    | BacConstructionDecl | BacWidgetDecl
  | BacMacroDecl    | BacDefaultsBlock   | BacSettingsBlock;

interface BacMemberBase {
  location:   BacSourceLocation;
  decorators: BacDecorator[];
}

export interface BacVariableDecl extends BacMemberBase {
  kind:         'variable';
  name:         string;
  type:         BacTypeRef;
  initializer?: BacExpr;
}
export interface BacComponentDecl extends BacMemberBase {
  kind:         'component';
  name:         string;
  type:         BacTypeRef;
  attachParent: string;            // empty for root
  defaults:     BacAssignment[];
}
export interface BacFunctionDecl extends BacMemberBase {
  kind:           'function';
  name:           string;
  params:         BacParam[];
  returnType?:    BacTypeRef;
  body:           BacBlockStmt;
  isPure:         boolean;
  /** Empty unless `implements IFoo.Method` was specified. */
  interfaceImpl:  string;
}
export interface BacEventDecl extends BacMemberBase {
  kind:    'event';
  name:    string;
  params:  BacParam[];
  body:    BacBlockStmt;
}
export interface BacConstructionDecl extends BacMemberBase {
  kind:  'construction';
  body:  BacBlockStmt;
}
export interface BacWidgetDecl extends BacMemberBase {
  kind:     'widget';
  name:     string;
  type:     BacTypeRef;
  defaults: BacAssignment[];
  children: BacWidgetDecl[];
}
export interface BacMacroDecl extends BacMemberBase {
  kind:        'macro';
  name:        string;
  params:      BacParam[];
  returnType?: BacTypeRef;
  body:        BacBlockStmt;
}
/**
 * `defaults { Property = Expression … }` — class-scope CDO overrides.
 * Each assignment routes through FProperty::ImportText into the BPGC's
 * class default object on the engine side. Mirrors the C++ FBacDefaultsBlock.
 */
export interface BacDefaultsBlock extends BacMemberBase {
  kind:        'defaults';
  assignments: BacAssignment[];
}
/**
 * `settings { Property = Expression … }` — UBlueprint metadata block,
 * the editor's "Class Settings" panel. Same body shape as `defaults`,
 * but the plugin generator targets the UBlueprint asset (NOT its CDO),
 * and the transcriber walks UBlueprint UPROPERTYs filtered by
 * Category=BlueprintOptions/ClassOptions to populate it. New UE Class-
 * Settings fields auto-round-trip without code changes — the whole
 * point of using reflection over hand-listed decorators.
 * Mirrors the C++ FBacSettingsBlock.
 */
export interface BacSettingsBlock extends BacMemberBase {
  kind:        'settings';
  assignments: BacAssignment[];
}

// ─── Top level ──────────────────────────────────────────────────────────────
export interface BacImport {
  location: BacSourceLocation;
  names:    string[];
  fromPath: string;
}

export interface BacClassDecl {
  location:               BacSourceLocation;
  name:                   string;
  parentTypeName:         string;
  implementedInterfaces:  string[];
  decorators:             BacDecorator[];
  members:                BacMember[];
}

/**
 * `interface IFoo { method-decls }` — Blueprint Interface (BPTYPE_Interface).
 * Body restricted to `function` or `event` signatures with empty bodies; no
 * state. Implementing classes write `class … implements IFoo { … }`.
 * Mirrors the C++ FBacInterfaceDecl.
 */
export interface BacInterfaceDecl {
  location:    BacSourceLocation;
  name:        string;
  decorators:  BacDecorator[];
  methods:     BacMember[];     // BacFunctionDecl or BacEventDecl, bodies empty
}

/**
 * `struct Foo { var Field: Type … }` — UUserDefinedStruct asset. Mirrors the
 * C++ FBacStructDecl. Body is a flat list of variable declarations only.
 */
export interface BacStructDecl {
  location:    BacSourceLocation;
  name:        string;
  decorators:  BacDecorator[];
  fields:      BacVariableDecl[];
}

/**
 * `asset Foo : ParentClass { Property = Value … }` — single UObject instance
 * (data assets, physical materials, sound classes, …). Mirrors the C++
 * FBacAssetDecl. Body is the same `Property = Value` shape the class-scope
 * `defaults { ... }` block uses.
 */
export interface BacAssetDecl {
  location:        BacSourceLocation;
  name:            string;
  parentTypeName:  string;
  decorators:      BacDecorator[];
  assignments:     BacAssignment[];
}

export interface BacTableRow {
  location:    BacSourceLocation;
  name:        string;
  assignments: BacAssignment[];
}

/**
 * `table Foo : RowStruct { row "Name" { Property = Value … } … }` — UDataTable
 * asset whose rows are instances of `RowStruct`. Mirrors the C++ FBacTableDecl.
 */
export interface BacTableDecl {
  location:        BacSourceLocation;
  name:            string;
  rowStructName:   string;
  decorators:      BacDecorator[];
  rows:            BacTableRow[];
}

export interface BacScriptAst {
  imports:    BacImport[];
  class?:     BacClassDecl;
  interface?: BacInterfaceDecl;
  struct?:    BacStructDecl;
  asset?:     BacAssetDecl;
  table?:     BacTableDecl;
}
