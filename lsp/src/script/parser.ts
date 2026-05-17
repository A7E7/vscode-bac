// 1:1 port of BacParser.cpp.
//
// Recursive-descent parser. Mirrors the structure of the C++ parser one-to-one
// — every parse function here corresponds to a parse function in BacParser.cpp,
// and diagnostic codes (BAC10xx) are wire-stable.

import { BacDiagnostics, BacSourceLocation, NO_LOCATION } from './diagnostics';
import { BacToken, BacTokenKind, tokenKindName } from './token';
import * as ast from './ast';

export function parse(tokens: BacToken[], diagnostics: BacDiagnostics): ast.BacScriptAst {
  return new Parser(tokens, diagnostics).parse();
}

// ─── Op tables ──────────────────────────────────────────────────────────────
function tokenToAssignOp(k: BacTokenKind): ast.BacAssignOp | undefined {
  switch (k) {
    case BacTokenKind.Assign:    return 'assign';
    case BacTokenKind.PlusEq:    return 'plus_eq';
    case BacTokenKind.MinusEq:   return 'minus_eq';
    case BacTokenKind.StarEq:    return 'star_eq';
    case BacTokenKind.SlashEq:   return 'slash_eq';
    case BacTokenKind.PercentEq: return 'percent_eq';
  }
  return undefined;
}
function tokenToCmpOp(k: BacTokenKind): ast.BacBinaryOp | undefined {
  switch (k) {
    case BacTokenKind.EqEq:  return 'eq';
    case BacTokenKind.NotEq: return 'not_eq';
    case BacTokenKind.Lt:    return 'lt';
    case BacTokenKind.Gt:    return 'gt';
    case BacTokenKind.LtEq:  return 'lt_eq';
    case BacTokenKind.GtEq:  return 'gt_eq';
  }
  return undefined;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: BacToken[], private readonly diags: BacDiagnostics) {}

  // ─── Cursor helpers ──────────────────────────────────────────────────────
  private at(offset = 0): BacToken {
    const i = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[Math.max(i, 0)];
  }
  private current(): BacToken { return this.at(0); }
  private check(k: BacTokenKind): boolean { return this.current().kind === k; }
  private isAtEnd(): boolean { return this.current().kind === BacTokenKind.Eof; }
  private advance(): void { if (!this.isAtEnd()) { this.pos++; } }
  private match(k: BacTokenKind): boolean {
    if (this.check(k)) { this.advance(); return true; }
    return false;
  }
  private skipNewlines(): void { while (this.check(BacTokenKind.Newline)) { this.advance(); } }

  private expect(k: BacTokenKind, what: string): boolean {
    if (this.match(k)) { return true; }
    const cur = this.current();
    const got = cur.lexeme || tokenKindName(cur.kind);
    this.error(`Expected ${what} but got '${got}'.`, cur.location, 'BAC1001');
    return false;
  }
  private expectIdentifier(what: string): string {
    if (!this.check(BacTokenKind.Identifier)) {
      const cur = this.current();
      this.error(`Expected ${what} (identifier) but got '${tokenKindName(cur.kind)}'.`,
        cur.location, 'BAC1002');
      return '';
    }
    const name = this.current().lexeme;
    this.advance();
    return name;
  }
  // Property-override name, possibly dotted: `Foo`, `Slot.Anchors`, `A.B.C`.
  // Stored verbatim in BacAssignment.name; the plugin generator splits on
  // the first dot to dispatch (Slot.* → child slot, others → widget).
  private expectAssignmentName(what: string): string {
    let name = this.expectIdentifier(what);
    if (!name) { return name; }
    while (this.match(BacTokenKind.Dot)) {
      const next = this.expectIdentifier("identifier after '.'");
      if (!next) { break; }
      name += '.' + next;
    }
    return name;
  }
  private error(message: string, location: BacSourceLocation, code: string): void {
    this.diags.error(message, location, code);
  }

  // ─── Backtracking ────────────────────────────────────────────────────────
  private save(): { pos: number; diagCount: number } {
    return { pos: this.pos, diagCount: this.diags.items.length };
  }
  private restore(s: { pos: number; diagCount: number }): void {
    this.pos = s.pos;
    this.diags.items.length = s.diagCount;
  }

  // ─── Recovery ────────────────────────────────────────────────────────────
  private syncToMemberOrEnd(): void {
    while (!this.isAtEnd()) {
      switch (this.current().kind) {
        case BacTokenKind.RBrace:
        case BacTokenKind.At:
        case BacTokenKind.Kw_Var:
        case BacTokenKind.Kw_Component:
        case BacTokenKind.Kw_Function:
        case BacTokenKind.Kw_Pure:
        case BacTokenKind.Kw_Event:
        case BacTokenKind.Kw_Construction:
          return;
        default: this.advance();
      }
    }
  }

  // ─── Top-level ───────────────────────────────────────────────────────────
  parse(): ast.BacScriptAst {
    const out: ast.BacScriptAst = { imports: [] };
    this.skipNewlines();

    while (this.check(BacTokenKind.Kw_Import)) {
      const imp = this.tryParseImport();
      if (imp) { out.imports.push(imp); }
      this.skipNewlines();
    }

    const topDecorators = this.parseDecorators();
    this.skipNewlines();

    if (this.check(BacTokenKind.Kw_Class)) {
      out.class = this.parseClassDecl(topDecorators);
    } else if (this.check(BacTokenKind.Kw_Interface)) {
      out.interface = this.parseInterfaceDecl(topDecorators);
    } else if (this.check(BacTokenKind.Kw_Struct)) {
      out.struct = this.parseStructDecl(topDecorators);
    } else if (this.check(BacTokenKind.Kw_Asset)) {
      out.asset = this.parseAssetDecl(topDecorators);
    } else if (this.check(BacTokenKind.Kw_Table)) {
      out.table = this.parseTableDecl(topDecorators);
    } else {
      this.error("Expected 'class', 'interface', 'struct', 'asset', or 'table' declaration after imports/decorators.",
        this.current().location, 'BAC1010');
      return out;
    }
    this.skipNewlines();

    if (!this.isAtEnd()) {
      this.error('Unexpected tokens after end of top-level declaration. Only one top-level decl per .bac file is supported.',
        this.current().location, 'BAC1011');
    }
    return out;
  }

  // `struct Foo { var Field: Type [= default] … }` — UUserDefinedStruct asset.
  // Body holds `var` field declarations only; per-field decorators (the same
  // `@display(...)` shape BP variables use) are accepted.
  private parseStructDecl(decorators: ast.BacDecorator[]): ast.BacStructDecl {
    const out: ast.BacStructDecl = {
      location: this.current().location, decorators, name: '', fields: [],
    };
    this.advance(); // 'struct'
    out.name = this.expectIdentifier('struct name');
    this.skipNewlines();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open struct body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }

      const fieldDecorators = this.parseDecorators();
      this.skipNewlines();

      if (this.check(BacTokenKind.Kw_Var)) {
        const field = this.parseVariableDecl(fieldDecorators);
        out.fields.push(field);
      } else {
        this.error(
          `Expected 'var' field declaration in struct body but got '${tokenKindName(this.current().kind)}'.`,
          this.current().location, 'BAC1022');
        // Skip to the next sync point so a single bad field doesn't tank the parse.
        this.advance();
      }
    }

    this.expect(BacTokenKind.RBrace, "'}' to close struct body");
    return out;
  }

  // `asset Foo : ParentClass { Property = Value … }` — UObject instance
  // (data assets, physical materials, …). Body shape matches the
  // class-scope `defaults { ... }` block.
  private parseAssetDecl(decorators: ast.BacDecorator[]): ast.BacAssetDecl {
    const out: ast.BacAssetDecl = {
      location: this.current().location, decorators,
      name: '', parentTypeName: '', assignments: [],
    };
    this.advance(); // 'asset'
    out.name = this.expectIdentifier('asset name');
    if (!this.expect(BacTokenKind.Colon, "':' before asset parent type")) { return out; }
    out.parentTypeName = this.expectIdentifier('parent class name');
    const qp = this.parseOptionalQualifiedPath();
    if (qp) { out.parentQualifiedPath = qp; }
    this.skipNewlines();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open asset body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
      const location = this.current().location;
      const name = this.expectAssignmentName('asset property name');
      if (!name) { break; }
      if (!this.expect(BacTokenKind.Assign, "'=' after asset property name")) { break; }
      const value = this.parseExpr();
      if (!value) { break; }
      out.assignments.push({ name, value, location });
      this.skipNewlines();
      this.match(BacTokenKind.Comma);
    }

    this.expect(BacTokenKind.RBrace, "'}' to close asset body");
    return out;
  }

  // `table Foo : RowStruct { row "Name" { ... } }` — UDataTable asset.
  // Each `row "..."` body is a `Property = Value` list.
  private parseTableDecl(decorators: ast.BacDecorator[]): ast.BacTableDecl {
    const out: ast.BacTableDecl = {
      location: this.current().location, decorators,
      name: '', rowStructName: '', rows: [],
    };
    this.advance(); // 'table'
    out.name = this.expectIdentifier('table name');
    if (!this.expect(BacTokenKind.Colon, "':' before table row struct")) { return out; }
    out.rowStructName = this.expectIdentifier('row struct name');
    this.skipNewlines();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open table body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }

      if (!this.check(BacTokenKind.Kw_Row)) {
        this.error(
          `Expected 'row "..."' inside table body but got '${tokenKindName(this.current().kind)}'.`,
          this.current().location, 'BAC1023');
        this.advance();
        continue;
      }
      const rowLocation = this.current().location;
      this.advance(); // 'row'
      if (!this.check(BacTokenKind.StringLit)) {
        this.error("Expected string literal row name after 'row'.",
          this.current().location, 'BAC1024');
        continue;
      }
      // Strip surrounding quotes from the lexeme.
      let rowName = this.current().lexeme;
      if (rowName.length >= 2 && rowName.startsWith('"') && rowName.endsWith('"')) {
        rowName = rowName.slice(1, -1);
      }
      this.advance();
      if (!this.expect(BacTokenKind.LBrace, "'{' to open row body")) { continue; }
      const assignments: ast.BacAssignment[] = [];
      while (true) {
        this.skipNewlines();
        if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
        const aLocation = this.current().location;
        const aName = this.expectAssignmentName('row property name');
        if (!aName) { break; }
        if (!this.expect(BacTokenKind.Assign, "'=' after row property name")) { break; }
        const aValue = this.parseExpr();
        if (!aValue) { break; }
        assignments.push({ name: aName, value: aValue, location: aLocation });
        this.skipNewlines();
        this.match(BacTokenKind.Comma);
      }
      this.expect(BacTokenKind.RBrace, "'}' to close row body");
      out.rows.push({ location: rowLocation, name: rowName, assignments });
    }

    this.expect(BacTokenKind.RBrace, "'}' to close table body");
    return out;
  }

  // ─── Imports ─────────────────────────────────────────────────────────────
  private tryParseImport(): ast.BacImport | undefined {
    const location = this.current().location;
    this.advance(); // 'import'
    if (!this.expect(BacTokenKind.LBrace, "'{' to begin imported names")) { return undefined; }
    const names: string[] = [];
    while (true) {
      const name = this.expectIdentifier('imported identifier');
      if (!name) { return undefined; }
      names.push(name);
      if (this.match(BacTokenKind.Comma)) { continue; }
      break;
    }
    if (!this.expect(BacTokenKind.RBrace, "'}' to close imports")) { return undefined; }
    if (!this.expect(BacTokenKind.Kw_From, "'from' after import names")) { return undefined; }
    if (!this.check(BacTokenKind.StringLit)) {
      this.error("Expected string literal path after 'from'.", this.current().location, 'BAC1003');
      return undefined;
    }
    let path = this.current().lexeme;
    if (path.length >= 2 && path[0] === '"' && path[path.length - 1] === '"') {
      path = path.slice(1, -1);
    }
    this.advance();
    return { location, names, fromPath: path };
  }

  // ─── Decorators ──────────────────────────────────────────────────────────
  private parseDecorators(): ast.BacDecorator[] {
    const out: ast.BacDecorator[] = [];
    while (true) {
      this.skipNewlines();
      if (!this.check(BacTokenKind.At)) { break; }
      const d = this.parseDecorator();
      if (!d) { break; }
      out.push(d);
    }
    return out;
  }

  private isKeywordTokenKind(k: BacTokenKind): boolean {
    // Accept the entire `Kw_*` block — any keyword token can serve as a
    // decorator name (e.g. `@event`, `@default`, `@const`). The upper
    // bound is the LAST keyword in `BacTokenKind` (currently `Kw_Const`);
    // mirrors `BacParser::TryConsumeNameAllowingKeywords` on the C++ side.
    return k >= BacTokenKind.Kw_Class && k <= BacTokenKind.Kw_Const;
  }
  private tryConsumeNameAllowingKeywords(): string | undefined {
    const k = this.current().kind;
    if (k !== BacTokenKind.Identifier && !this.isKeywordTokenKind(k)) { return undefined; }
    const name = this.current().lexeme;
    this.advance();
    return name;
  }

  private parseDecorator(): ast.BacDecorator | undefined {
    const location = this.current().location;
    if (!this.match(BacTokenKind.At)) { return undefined; }
    const name = this.tryConsumeNameAllowingKeywords();
    if (name === undefined) {
      this.error(`Expected decorator name after '@' but got '${tokenKindName(this.current().kind)}'.`,
        this.current().location, 'BAC1002');
      return undefined;
    }
    const args: ast.BacDecoratorArg[] = [];
    if (this.match(BacTokenKind.LParen)) {
      if (!this.check(BacTokenKind.RParen)) {
        while (true) {
          let argName: string | undefined;
          if (this.check(BacTokenKind.Identifier) && this.at(1).kind === BacTokenKind.Assign) {
            argName = this.current().lexeme;
            this.advance(); // ident
            this.advance(); // =
          }
          const value = this.parseExpr();
          if (!value) { break; }
          args.push(argName ? { name: argName, value } : { value });
          if (this.match(BacTokenKind.Comma)) { continue; }
          break;
        }
      }
      this.expect(BacTokenKind.RParen, "')' to close decorator arguments");
    }
    return { location, name, args };
  }

  // ─── Class ───────────────────────────────────────────────────────────────
  private parseClassDecl(decorators: ast.BacDecorator[]): ast.BacClassDecl {
    const out: ast.BacClassDecl = {
      location: this.current().location,
      name: '', parentTypeName: '',
      implementedInterfaces: [], decorators, members: [],
    };
    this.advance(); // 'class'
    out.name = this.expectIdentifier('class name');
    if (this.match(BacTokenKind.Colon)) {
      out.parentTypeName = this.expectIdentifier('parent class name');
      const qp = this.parseOptionalQualifiedPath();
      if (qp) { out.parentQualifiedPath = qp; }
    }
    this.skipNewlines();
    if (this.match(BacTokenKind.Kw_Implements)) {
      const ifacePaths: string[] = [];
      while (true) {
        this.skipNewlines();
        const iface = this.expectIdentifier('interface name');
        if (!iface) { break; }
        out.implementedInterfaces.push(iface);
        ifacePaths.push(this.parseOptionalQualifiedPath());
        if (!this.match(BacTokenKind.Comma)) { break; }
      }
      if (ifacePaths.some(p => p !== '')) {
        out.interfaceQualifiedPaths = ifacePaths;
      }
    }
    this.skipNewlines();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open class body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
      const m = this.parseMember();
      if (m) { out.members.push(m); }
      else   { this.syncToMemberOrEnd(); }
    }
    this.expect(BacTokenKind.RBrace, "'}' to close class body");
    return out;
  }

  // ─── Interface ───────────────────────────────────────────────────────────
  // `interface IFoo { function Bar(args): Ret  event Baz(args) }` — Blueprint
  // Interface declaration. Body holds method signatures only (function or
  // event); var/component/defaults/settings/construction/widget/macro are
  // rejected with BAC1015. No `: Parent` (UE auto-parents to UInterface)
  // and no `implements` clause.
  private parseInterfaceDecl(decorators: ast.BacDecorator[]): ast.BacInterfaceDecl {
    const out: ast.BacInterfaceDecl = {
      location: this.current().location,
      name: '', decorators, methods: [],
    };
    this.advance(); // 'interface'
    out.name = this.expectIdentifier('interface name');
    this.skipNewlines();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open interface body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }

      const memberStart = this.current().location;
      const m = this.parseMember();
      if (!m) { this.syncToMemberOrEnd(); continue; }

      if (m.kind === 'function' || m.kind === 'event') {
        out.methods.push(m);
      } else {
        this.error(
          "Only 'function' or 'event' declarations are allowed in an interface body.",
          memberStart, 'BAC1015');
      }
    }
    this.expect(BacTokenKind.RBrace, "'}' to close interface body");
    return out;
  }

  // ─── Members ─────────────────────────────────────────────────────────────
  private parseMember(): ast.BacMember | undefined {
    const decorators = this.parseDecorators();
    this.skipNewlines();

    switch (this.current().kind) {
      case BacTokenKind.Kw_Var:          return this.parseVariableDecl(decorators);
      case BacTokenKind.Kw_Component:    return this.parseComponentDecl(decorators);
      case BacTokenKind.Kw_Function:     return this.parseFunctionDecl(decorators, false);
      case BacTokenKind.Kw_Pure: {
        this.advance();
        if (this.check(BacTokenKind.Kw_Function)) {
          return this.parseFunctionDecl(decorators, true);
        }
        if (this.check(BacTokenKind.Kw_Macro)) {
          return this.parseMacroDecl(decorators, true);
        }
        this.error("Expected 'function' or 'macro' after 'pure'.", this.current().location, 'BAC1020');
        return undefined;
      }
      case BacTokenKind.Kw_Event:        return this.parseEventDecl(decorators);
      case BacTokenKind.Kw_Construction: return this.parseConstructionDecl(decorators);
      case BacTokenKind.Kw_Widget:       return this.parseWidgetDecl(decorators);
      case BacTokenKind.Kw_Macro:        return this.parseMacroDecl(decorators);
      case BacTokenKind.Kw_Defaults:     return this.parseDefaultsBlock(decorators);
      case BacTokenKind.Kw_Settings:     return this.parseSettingsBlock(decorators);
      case BacTokenKind.Kw_Timeline:     return this.parseTimelineDecl(decorators);
      default: {
        this.error(
          `Expected class member (var, component, function, event, construction, widget, animation, timeline, macro, defaults, settings) but got '${tokenKindName(this.current().kind)}'.`,
          this.current().location, 'BAC1021');
        return undefined;
      }
    }
  }

  // `defaults { Property = Expression … }` — class-scope CDO overrides.
  // Body shape mirrors the component default-overrides body (one
  // `Name = Expr` per line, optional trailing comma, terminated by `}`).
  // Decorators are accepted but currently ignored — the engine has no
  // per-defaults-block decorator yet.
  private parseDefaultsBlock(decorators: ast.BacDecorator[]): ast.BacDefaultsBlock {
    const out: ast.BacDefaultsBlock = {
      kind: 'defaults', location: this.current().location, decorators,
      assignments: [],
    };
    this.advance(); // 'defaults'
    if (!this.expect(BacTokenKind.LBrace, "'{' to open defaults body")) { return out; }
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
      const location = this.current().location;
      const name = this.expectAssignmentName('class default property name');
      if (!name) { break; }
      if (!this.expect(BacTokenKind.Assign, "'=' after class default property name")) { break; }
      const value = this.parseExpr();
      if (!value) { break; }
      out.assignments.push({ name, value, location });
      this.skipNewlines();
      this.match(BacTokenKind.Comma);
    }
    this.expect(BacTokenKind.RBrace, "'}' to close defaults body");
    return out;
  }

  // `settings { Property = Expression … }` — UBlueprint metadata block,
  // the editor's "Class Settings" panel. Body shape is identical to
  // `defaults` — both lower to FProperty::ImportText through the same
  // shared assignment parser; the difference is the target (UBlueprint
  // asset vs. its CDO), which the plugin generator dispatches on.
  private parseSettingsBlock(decorators: ast.BacDecorator[]): ast.BacSettingsBlock {
    const out: ast.BacSettingsBlock = {
      kind: 'settings', location: this.current().location, decorators,
      assignments: [],
    };
    this.advance(); // 'settings'
    if (!this.expect(BacTokenKind.LBrace, "'{' to open settings body")) { return out; }
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
      const location = this.current().location;
      const name = this.expectAssignmentName('class setting property name');
      if (!name) { break; }
      if (!this.expect(BacTokenKind.Assign, "'=' after class setting property name")) { break; }
      const value = this.parseExpr();
      if (!value) { break; }
      out.assignments.push({ name, value, location });
      this.skipNewlines();
      this.match(BacTokenKind.Comma);
    }
    this.expect(BacTokenKind.RBrace, "'}' to close settings body");
    return out;
  }

  private parseVariableDecl(decorators: ast.BacDecorator[]): ast.BacVariableDecl {
    const out: ast.BacVariableDecl = {
      kind: 'variable', location: this.current().location, decorators,
      name: '', type: { location: NO_LOCATION, baseName: '', genericArgs: [], arrayDepth: 0 },
    };
    this.advance(); // 'var'
    out.name = this.expectIdentifier('variable name');
    if (!this.expect(BacTokenKind.Colon, "':' before variable type")) { return out; }
    out.type = this.parseTypeRef();
    if (this.match(BacTokenKind.Assign)) {
      const init = this.parseExpr();
      if (init) { out.initializer = init; }
    }
    return out;
  }

  private parseComponentDecl(decorators: ast.BacDecorator[]): ast.BacComponentDecl {
    const out: ast.BacComponentDecl = {
      kind: 'component', location: this.current().location, decorators,
      name: '', type: { location: NO_LOCATION, baseName: '', genericArgs: [], arrayDepth: 0 },
      attachParent: '', defaults: [],
    };
    this.advance(); // 'component'
    out.name = this.expectIdentifier('component name');
    if (!this.expect(BacTokenKind.Colon, "':' before component type")) { return out; }
    out.type = this.parseTypeRef();
    if (this.match(BacTokenKind.Kw_Attach)) {
      out.attachParent = this.expectIdentifier('attach-parent component name');
    }
    if (this.match(BacTokenKind.LBrace)) {
      while (true) {
        this.skipNewlines();
        if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
        const location = this.current().location;
        const name = this.expectAssignmentName('property name');
        if (!name) { break; }
        if (!this.expect(BacTokenKind.Assign, "'=' between property name and value")) { break; }
        const value = this.parseExpr();
        if (!value) { break; }
        out.defaults.push({ name, value, location });
        this.skipNewlines();
        // optional comma
        this.match(BacTokenKind.Comma);
      }
      this.expect(BacTokenKind.RBrace, "'}' to close component body");
    }
    return out;
  }

  private parseFunctionDecl(decorators: ast.BacDecorator[], isPure: boolean): ast.BacFunctionDecl {
    const out: ast.BacFunctionDecl = {
      kind: 'function', location: this.current().location, decorators,
      name: '', params: [], body: { kind: 'block', location: NO_LOCATION, statements: [] },
      isPure, interfaceImpl: '',
    };
    this.advance(); // 'function'
    out.name = this.expectIdentifier('function name');
    if (!this.expect(BacTokenKind.LParen, "'(' to begin parameter list")) { return out; }
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RParen)) { break; }
      const p = this.parseParam();
      if (!p) { break; }
      out.params.push(p);
      this.skipNewlines();
      if (!this.match(BacTokenKind.Comma)) { break; }
    }
    this.skipNewlines();
    this.expect(BacTokenKind.RParen, "')' to close parameter list");
    if (this.match(BacTokenKind.Colon)) { out.returnType = this.parseTypeRef(); }
    if (this.match(BacTokenKind.Kw_Implements)) {
      const iface = this.expectIdentifier("interface name (before '.method')");
      this.expect(BacTokenKind.Dot, "'.' between interface and method");
      const method = this.expectIdentifier('interface method name');
      out.interfaceImpl = `${iface}.${method}`;
    }
    this.skipNewlines();
    out.body = this.parseBlock();
    return out;
  }

  // `[pure] macro Name(params)[: Ret] { body }` — produces a BacMacroDecl.
  // The plugin's generator stores macros on Blueprint->MacroGraphs with
  // UK2Node_Tunnel terminators.
  //
  // Unified macro syntax: `:Exec`-typed params model the macro's input
  // (`In: Exec`) and output (`out Foo: Exec`) exec pins in declaration
  // order. Non-`out` `:Exec` params produce InputTunnel exec OUTPUT pins
  // (each drives a body block); `out X: Exec` produces OutputTunnel
  // exec INPUT pins (drivable by bare `X()` route calls from inside any
  // body).
  //
  // Body shape:
  //   • non-pure (has `:Exec` input params) — sequence of `Name() { stmts }`
  //     blocks, one per `:Exec` input param, matched by name.
  //   • pure macro (no `:Exec` params anywhere) — single statement-list
  //     body. Pin-flow shape mirrors `pure function` exactly.
  private parseMacroDecl(decorators: ast.BacDecorator[], bPure: boolean = false): ast.BacMacroDecl {
    const out: ast.BacMacroDecl = {
      kind: 'macro', location: this.current().location, decorators,
      name: '', bPure, params: [], outputs: [], inputBodies: [],
      body: { kind: 'block', location: NO_LOCATION, statements: [] },
    };
    this.advance(); // 'macro'
    out.name = this.expectIdentifier('macro name');
    if (!this.expect(BacTokenKind.LParen, "'(' to begin parameter list")) { return out; }
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RParen)) { break; }
      const p = this.parseParam();
      if (!p) { break; }
      out.params.push(p);
      this.skipNewlines();
      if (!this.match(BacTokenKind.Comma)) { break; }
    }
    this.skipNewlines();
    this.expect(BacTokenKind.RParen, "')' to close parameter list");
    if (this.match(BacTokenKind.Colon)) { out.returnType = this.parseTypeRef(); }
    this.skipNewlines();

    // Derive InputBodies / Outputs from the param list. `:Exec` typed
    // params name the macro's exec pins; non-`out` becomes an
    // InputTunnel exec output pin (driving a body block), `out` becomes
    // an OutputTunnel exec input pin (drivable by route calls from
    // inside any body). The order in the param list determines pin
    // order in BP.
    for (const p of out.params) {
      if (!p.type || p.type.baseName !== 'Exec') { continue; }
      if (p.bIsOut) {
        out.outputs.push({ name: p.name, decorators: [], location: out.location });
      } else {
        out.inputBodies.push({ name: p.name, decorators: [], location: out.location });
      }
    }

    if (out.inputBodies.length > 0) {
      // Non-pure: sequence of `Name() { stmts }` blocks, one per
      // declared `:Exec` input param, matched by name.
      this.expect(BacTokenKind.LBrace, "'{' to begin macro body");
      while (true) {
        this.skipNewlines();
        if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
        const nameTok = this.current();
        const blockName = this.expectIdentifier('input-body block name');
        if (!blockName) { break; }
        this.expect(BacTokenKind.LParen, "'(' after input-body block name");
        this.expect(BacTokenKind.RParen, "')' after input-body block name");
        const blockBody = this.parseBlock();
        const slot = out.inputBodies.find(b => b.name === blockName);
        if (slot) {
          if (slot.body) {
            this.error(
              `Macro '${out.name}': duplicate body for input '${blockName}'.`,
              nameTok.location, 'BAC1027');
          } else {
            slot.body = blockBody;
          }
        } else {
          this.error(
            `Macro '${out.name}': input-body block '${blockName}' does not match any declared \`:Exec\` input parameter.`,
            nameTok.location, 'BAC1028');
        }
        this.skipNewlines();
      }
      this.expect(BacTokenKind.RBrace, "'}' to close macro body");

      // Every declared `:Exec` input must have a matching body block.
      for (const slot of out.inputBodies) {
        if (!slot.body) {
          this.error(
            `Macro '${out.name}': input '${slot.name}' (\`:Exec\` parameter) has no matching \`${slot.name}() { ... }\` body block.`,
            slot.location, 'BAC1032');
        }
      }
    } else {
      out.body = this.parseBlock();
    }
    return out;
  }

  private parseEventDecl(decorators: ast.BacDecorator[]): ast.BacEventDecl {
    const out: ast.BacEventDecl = {
      kind: 'event', location: this.current().location, decorators,
      name: '', params: [], body: { kind: 'block', location: NO_LOCATION, statements: [] },
    };
    this.advance(); // 'event'
    out.name = this.expectIdentifier('event name');
    if (!this.expect(BacTokenKind.LParen, "'(' to begin parameter list")) { return out; }
    if (!this.check(BacTokenKind.RParen)) {
      while (true) {
        this.skipNewlines();
        const p = this.parseParam();
        if (!p) { break; }
        out.params.push(p);
        this.skipNewlines();
        if (this.match(BacTokenKind.Comma)) { continue; }
        break;
      }
    }
    this.skipNewlines();
    this.expect(BacTokenKind.RParen, "')' to close parameter list");
    this.skipNewlines();
    out.body = this.parseBlock();
    return out;
  }

  private parseConstructionDecl(decorators: ast.BacDecorator[]): ast.BacConstructionDecl {
    const location = this.current().location;
    this.advance(); // 'construction'
    const body = this.parseBlock();
    return { kind: 'construction', location, decorators, body };
  }

  // `timeline X { settings; tracks; handlers }`. Body interleaves three
  // line shapes (newline- or semicolon-terminated):
  //   • `Name = Expr`                — setting (Length, LengthMode, AutoPlay, …)
  //   • `track Name[: Type [= Src]]` — track decl (event track when no type)
  //   • `event Name(params) { body }` — handler bound to an exec output
  private parseTimelineDecl(decorators: ast.BacDecorator[]): ast.BacTimelineDecl {
    const out: ast.BacTimelineDecl = {
      kind: 'timeline', location: this.current().location, decorators,
      name: '', settings: [], tracks: [], handlers: [],
    };
    this.advance(); // 'timeline'
    out.name = this.expectIdentifier('timeline name');
    if (!out.name) { return out; }
    if (!this.expect(BacTokenKind.LBrace, "'{' to open timeline body")) { return out; }

    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }

      if (this.check(BacTokenKind.Kw_Event)) {
        const ev = this.parseEventDecl([]);
        out.handlers.push(ev);
        this.skipNewlines();
        continue;
      }

      if (this.check(BacTokenKind.Kw_Track)) {
        const trackLoc = this.current().location;
        this.advance(); // 'track'
        // Track name accepts bare identifier OR quoted string-literal —
        // Designer-named tracks frequently carry spaces ("Movement lerp",
        // "Lock rotation"). 1:1 mirror of `BacParser.cpp::ParseTimelineDecl`.
        let name = '';
        if (this.check(BacTokenKind.StringLit)) {
          let lex = this.current().lexeme;
          if (lex.length >= 2 && lex[0] === '"' && lex[lex.length - 1] === '"') {
            lex = lex.slice(1, -1);
          }
          name = lex;
          this.advance();
        } else {
          name = this.expectIdentifier('track name');
        }
        if (!name) { this.syncToMemberOrEnd(); continue; }
        const track: ast.BacTrackDecl = { name, location: trackLoc };
        if (this.match(BacTokenKind.Colon)) {
          track.type = this.parseTypeRef();
          if (this.match(BacTokenKind.Assign)) {
            track.source = this.parseExpr() ?? undefined;
          }
        }
        out.tracks.push(track);
        this.skipNewlines();
        continue;
      }

      if (this.check(BacTokenKind.Identifier)) {
        const settingLoc = this.current().location;
        const name = this.expectAssignmentName('timeline setting name');
        if (!name) { this.syncToMemberOrEnd(); continue; }
        if (!this.expect(BacTokenKind.Assign, "'=' after timeline setting name")) {
          this.syncToMemberOrEnd();
          continue;
        }
        const value = this.parseExpr();
        if (!value) { break; }
        out.settings.push({ name, value, location: settingLoc });
        this.skipNewlines();
        continue;
      }

      this.error(
        `Unexpected token '${tokenKindName(this.current().kind)}' in timeline body — expected setting, 'track', or 'event'.`,
        this.current().location, 'BAC1027');
      this.advance();
    }
    this.expect(BacTokenKind.RBrace, "'}' to close timeline body");
    return out;
  }

  // `widget Name: Type { Body }` at the class top level. Body holds two
  // kinds of entries, freely interleaved:
  //   1. Property overrides — `Name = Expr`
  //   2. Nested child widgets — `ChildName: ChildType { ... }`
  // Children use the bare `Name: Type` form (no leading `widget` keyword)
  // so the syntax doesn't get noisy.
  private parseWidgetDecl(decorators: ast.BacDecorator[]): ast.BacWidgetDecl {
    const out: ast.BacWidgetDecl = {
      kind: 'widget', location: this.current().location, decorators,
      name: '', type: { location: NO_LOCATION, baseName: '', genericArgs: [], arrayDepth: 0 },
      defaults: [], children: [],
    };
    this.advance(); // 'widget'
    out.name = this.expectIdentifier('widget name');
    if (!this.expect(BacTokenKind.Colon, "':' before widget type")) { return out; }
    out.type = this.parseTypeRef();
    if (!this.expect(BacTokenKind.LBrace, "'{' to open widget body")) { return out; }
    this.parseWidgetBody(out);
    this.expect(BacTokenKind.RBrace, "'}' to close widget body");
    return out;
  }

  private parseChildWidgetDecl(): ast.BacWidgetDecl | undefined {
    const out: ast.BacWidgetDecl = {
      kind: 'widget', location: this.current().location, decorators: [],
      name: '', type: { location: NO_LOCATION, baseName: '', genericArgs: [], arrayDepth: 0 },
      defaults: [], children: [],
    };
    out.name = this.expectIdentifier('child widget name');
    if (!out.name) { return undefined; }
    if (!this.expect(BacTokenKind.Colon, "':' before child widget type")) { return out; }
    out.type = this.parseTypeRef();
    if (this.match(BacTokenKind.LBrace)) {
      this.parseWidgetBody(out);
      this.expect(BacTokenKind.RBrace, "'}' to close child widget body");
    }
    return out;
  }

  private parseWidgetBody(target: ast.BacWidgetDecl): void {
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }

      // Lookahead: `identifier ':'` is a child widget; `identifier '='` is
      // a property override.
      if (this.check(BacTokenKind.Identifier) && this.at(1).kind === BacTokenKind.Colon) {
        const child = this.parseChildWidgetDecl();
        if (child) { target.children.push(child); }
        this.skipNewlines();
        this.match(BacTokenKind.Comma);
        continue;
      }
      const location = this.current().location;
      const name = this.expectAssignmentName('widget property name');
      if (!name) { break; }
      // `=>` introduces a UMG property binding; `=` is a static override.
      let isBinding = false;
      if (this.match(BacTokenKind.FatArrow)) {
        isBinding = true;
      } else if (!this.expect(BacTokenKind.Assign, "'=' or '=>' between property name and value")) {
        break;
      }
      const value = this.parseExpr();
      if (!value) { break; }
      target.defaults.push({ name, value, location, isBinding });
      this.skipNewlines();
      this.match(BacTokenKind.Comma);
    }
  }

  private parseParam(): ast.BacParam | undefined {
    const decorators = this.parseDecorators();
    // `ref` / `const` / `out` modifiers — order is flexible (`ref const x`
    // and `const ref x` both parse) and any can be omitted. Mirrors the
    // C++ side at `BacParser.cpp::ParseParam`. Duplicates collapse
    // silently; idempotent on the BP-side flag bits. `out` marks an OUTPUT
    // param (FunctionResult); `ref`/`const` modify INPUT params
    // (FunctionEntry) — the two roles are mutually exclusive.
    let bIsByRef = false;
    let bIsConst = false;
    let bIsOut = false;
    while (this.check(BacTokenKind.Kw_Ref) || this.check(BacTokenKind.Kw_Const)
        || this.check(BacTokenKind.Kw_Out)) {
      if (this.match(BacTokenKind.Kw_Ref))        { bIsByRef = true; }
      else if (this.match(BacTokenKind.Kw_Const)) { bIsConst = true; }
      else if (this.match(BacTokenKind.Kw_Out))   { bIsOut = true; }
    }
    if (bIsOut && (bIsByRef || bIsConst)) {
      this.error(
        "'out' marks an output parameter and cannot combine with 'ref' or " +
        "'const' (those modify input parameters).",
        this.current().location, 'BAC1041');
      return undefined;
    }
    const name = this.expectIdentifier('parameter name');
    if (!name) { return undefined; }
    if (!this.expect(BacTokenKind.Colon, "':' before parameter type")) { return undefined; }
    const type = this.parseTypeRef();
    let defaultExpr: ast.BacExpr | undefined;
    if (this.match(BacTokenKind.Assign)) {
      const e = this.parseExpr();
      if (e) { defaultExpr = e; }
    }
    return { name, type, decorators, default: defaultExpr, bIsByRef, bIsConst, bIsOut };
  }

  // ─── Types ───────────────────────────────────────────────────────────────
  private parseTypeRef(): ast.BacTypeRef {
    const out: ast.BacTypeRef = {
      location: this.current().location, baseName: '', genericArgs: [], arrayDepth: 0,
    };
    out.baseName = this.expectIdentifier('type name');
    if (this.match(BacTokenKind.Lt)) {
      while (true) {
        this.skipNewlines();
        const arg = this.parseTypeRef();
        if (!arg.baseName) { break; }
        out.genericArgs.push(arg);
        if (this.match(BacTokenKind.Comma)) { continue; }
        break;
      }
      this.expect(BacTokenKind.Gt, "'>' to close generic arguments");
    }
    while (this.match(BacTokenKind.LBracket)) {
      this.expect(BacTokenKind.RBracket, "']' to close array marker");
      out.arrayDepth++;
    }
    const qp = this.parseOptionalQualifiedPath();
    if (qp) { out.qualifiedPath = qp; }
    return out;
  }

  // Optional `@/Game/Foo/Asset[.Object[_C]]` after a type or class-name
  // identifier. Returns the path verbatim; the plugin-side resolver
  // normalises into a loadable object path. 1:1 with C++ FParser::ParseOptionalQualifiedPath.
  private parseOptionalQualifiedPath(): string {
    if (!this.match(BacTokenKind.At)) { return ''; }
    if (!this.expect(BacTokenKind.Slash, "'/' after '@' in qualified type path")) { return ''; }
    let path = '/' + this.expectIdentifier("package segment after '@/'");
    while (this.check(BacTokenKind.Slash)) {
      this.advance();
      path += '/' + this.expectIdentifier("package segment after '/'");
    }
    if (this.match(BacTokenKind.Dot)) {
      path += '.' + this.expectIdentifier("object name after '.'");
    }
    return path;
  }

  // ─── Statements ──────────────────────────────────────────────────────────
  private parseBlock(): ast.BacBlockStmt {
    const out: ast.BacBlockStmt = {
      kind: 'block', location: this.current().location, statements: [],
    };
    if (!this.expect(BacTokenKind.LBrace, "'{' to begin block")) { return out; }
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RBrace) || this.isAtEnd()) { break; }
      const s = this.parseStmt();
      if (s) { out.statements.push(s); }
      this.skipNewlines();
    }
    this.expect(BacTokenKind.RBrace, "'}' to close block");
    return out;
  }

  private parseStmt(): ast.BacStmt | undefined {
    switch (this.current().kind) {
      case BacTokenKind.LBrace:    return this.parseBlock();
      case BacTokenKind.Kw_If:     return this.parseIf();
      case BacTokenKind.Kw_For:    return this.parseFor();
      case BacTokenKind.Kw_While:  return this.parseWhile();
      case BacTokenKind.Kw_Return: return this.parseReturn();
      case BacTokenKind.Kw_Break: {
        const location = this.current().location;
        this.advance();
        return { kind: 'break', location };
      }
      case BacTokenKind.Kw_Continue: {
        const location = this.current().location;
        this.advance();
        return { kind: 'continue', location };
      }
      case BacTokenKind.Kw_Reset: {
        // `reset <label>` — see the plugin parser for semantics. The
        // LSP captures the syntax for highlighting / navigation but
        // doesn't resolve the label (cross-class scope; mirror lag).
        const location = this.current().location;
        this.advance();
        const targetLabel = this.expectIdentifier("identifier label after 'reset'");
        return { kind: 'reset', location, targetLabel };
      }
      case BacTokenKind.Kw_Var: return this.parseVarDeclStmt(true);
      case BacTokenKind.Kw_Let: return this.parseVarDeclStmt(false);
      default: return this.parseAssignOrExprStmt();
    }
  }

  private parseIf(): ast.BacIfStmt {
    const out: ast.BacIfStmt = {
      kind: 'if', location: this.current().location,
      condition: { kind: 'none_lit', location: NO_LOCATION },
      then: { kind: 'block', location: NO_LOCATION, statements: [] },
    };
    this.advance(); // 'if'
    if (!this.expect(BacTokenKind.LParen, "'(' after 'if'")) { return out; }
    if (this.check(BacTokenKind.Kw_Let)) {
      this.advance();
      out.letName = this.expectIdentifier('binding name in if-let');
      this.expect(BacTokenKind.Assign, "'=' in if-let");
    }
    const cond = this.parseExpr();
    if (cond) { out.condition = cond; }
    this.expect(BacTokenKind.RParen, "')' to close 'if' condition");
    this.skipNewlines();
    out.then = this.parseBlock();
    this.skipNewlines();
    if (this.match(BacTokenKind.Kw_Else)) {
      this.skipNewlines();
      out.else = this.check(BacTokenKind.Kw_If) ? this.parseIf() : this.parseBlock();
    }
    return out;
  }

  private parseFor(): ast.BacForStmt {
    const out: ast.BacForStmt = {
      kind: 'for', location: this.current().location,
      bindingName: '',
      iterable: { kind: 'none_lit', location: NO_LOCATION },
      body: { kind: 'block', location: NO_LOCATION, statements: [] },
    };
    this.advance(); // 'for'
    if (!this.expect(BacTokenKind.LParen, "'(' after 'for'")) { return out; }
    out.bindingName = this.expectIdentifier("binding name in 'for'");
    if (this.match(BacTokenKind.Colon)) { out.bindingType = this.parseTypeRef(); }
    if (!this.expect(BacTokenKind.Kw_In, "'in' between binding and iterable")) { return out; }
    const iter = this.parseExpr();
    if (iter) { out.iterable = iter; }
    this.expect(BacTokenKind.RParen, "')' to close 'for' header");
    this.skipNewlines();
    out.body = this.parseBlock();
    return out;
  }

  private parseWhile(): ast.BacWhileStmt {
    const out: ast.BacWhileStmt = {
      kind: 'while', location: this.current().location,
      condition: { kind: 'none_lit', location: NO_LOCATION },
      body: { kind: 'block', location: NO_LOCATION, statements: [] },
    };
    this.advance(); // 'while'
    if (!this.expect(BacTokenKind.LParen, "'(' after 'while'")) { return out; }
    const cond = this.parseExpr();
    if (cond) { out.condition = cond; }
    this.expect(BacTokenKind.RParen, "')' to close 'while' condition");
    this.skipNewlines();
    out.body = this.parseBlock();
    return out;
  }

  private parseReturn(): ast.BacReturnStmt {
    const out: ast.BacReturnStmt = { kind: 'return', location: this.current().location };
    this.advance(); // 'return'
    if (!this.check(BacTokenKind.Newline) && !this.check(BacTokenKind.Semicolon) && !this.check(BacTokenKind.RBrace)) {
      const v = this.parseExpr();
      if (v) { out.value = v; }
    }
    return out;
  }

  private parseVarDeclStmt(isMutable: boolean): ast.BacVarDeclStmt {
    const out: ast.BacVarDeclStmt = {
      kind: 'var_decl', location: this.current().location,
      isMutable, name: '',
    };
    this.advance(); // 'var' or 'let'
    out.name = this.expectIdentifier('local variable name');
    if (this.match(BacTokenKind.Colon)) { out.type = this.parseTypeRef(); }
    if (this.match(BacTokenKind.Assign)) {
      const e = this.parseExpr();
      if (e) { out.initializer = e; }
    }
    return out;
  }

  private parseAssignOrExprStmt(): ast.BacStmt | undefined {
    const location = this.current().location;
    const lhs = this.parseExpr();
    if (!lhs) { return undefined; }
    const op = tokenToAssignOp(this.current().kind);
    if (op) {
      this.advance();
      const value = this.parseExpr();
      if (!value) { return undefined; }
      return { kind: 'assign', location, op, target: lhs, value };
    }
    return { kind: 'expr', location, expr: lhs };
  }

  // ─── Expressions ─────────────────────────────────────────────────────────
  private parseExpr(): ast.BacExpr | undefined { return this.parseOr(); }

  private parseOr(): ast.BacExpr | undefined {
    let lhs = this.parseAnd();
    while (lhs && this.match(BacTokenKind.PipePipe)) {
      const right = this.parseAnd();
      if (!right) { return lhs; }
      lhs = { kind: 'binary', location: lhs.location, op: 'or', left: lhs, right };
    }
    return lhs;
  }
  private parseAnd(): ast.BacExpr | undefined {
    let lhs = this.parseCmp();
    while (lhs && this.match(BacTokenKind.AmpAmp)) {
      const right = this.parseCmp();
      if (!right) { return lhs; }
      lhs = { kind: 'binary', location: lhs.location, op: 'and', left: lhs, right };
    }
    return lhs;
  }
  private parseCmp(): ast.BacExpr | undefined {
    let lhs = this.parseAdd();
    while (lhs) {
      const op = tokenToCmpOp(this.current().kind);
      if (!op) { break; }
      this.advance();
      const right = this.parseAdd();
      if (!right) { return lhs; }
      lhs = { kind: 'binary', location: lhs.location, op, left: lhs, right };
    }
    return lhs;
  }
  private parseAdd(): ast.BacExpr | undefined {
    let lhs = this.parseMul();
    while (lhs && (this.check(BacTokenKind.Plus) || this.check(BacTokenKind.Minus))) {
      const op: ast.BacBinaryOp = this.check(BacTokenKind.Plus) ? 'add' : 'sub';
      this.advance();
      const right = this.parseMul();
      if (!right) { return lhs; }
      lhs = { kind: 'binary', location: lhs.location, op, left: lhs, right };
    }
    return lhs;
  }
  private parseMul(): ast.BacExpr | undefined {
    let lhs = this.parseUnary();
    while (lhs && (this.check(BacTokenKind.Star) || this.check(BacTokenKind.Slash) || this.check(BacTokenKind.Percent))) {
      const op: ast.BacBinaryOp =
        this.check(BacTokenKind.Star)  ? 'mul' :
        this.check(BacTokenKind.Slash) ? 'div' :
                                          'mod';
      this.advance();
      const right = this.parseUnary();
      if (!right) { return lhs; }
      lhs = { kind: 'binary', location: lhs.location, op, left: lhs, right };
    }
    return lhs;
  }

  private parseUnary(): ast.BacExpr | undefined {
    if (this.match(BacTokenKind.Bang)) {
      const location = this.at(-1).location;
      const operand = this.parseUnary();
      if (!operand) { return undefined; }
      return { kind: 'unary', location, op: 'not', operand };
    }
    if (this.match(BacTokenKind.Minus)) {
      const location = this.at(-1).location;
      const operand = this.parseUnary();
      if (!operand) { return undefined; }
      return { kind: 'unary', location, op: 'negate', operand };
    }
    if (this.match(BacTokenKind.Kw_Await)) {
      const location = this.at(-1).location;
      const inner = this.parseUnary();
      if (!inner) { return undefined; }
      return { kind: 'await', location, inner };
    }
    return this.parsePostfix();
  }

  private parseCallArgs(out: ast.BacCallArg[]): boolean {
    while (true) {
      this.skipNewlines();
      if (this.check(BacTokenKind.RParen)) { break; }
      let name: string | undefined;
      if (this.check(BacTokenKind.Identifier) && this.at(1).kind === BacTokenKind.Assign) {
        name = this.current().lexeme;
        this.advance(); this.advance();
      }
      const value = this.parseExpr();
      if (!value) { break; }
      out.push(name ? { name, value } : { value });
      this.skipNewlines();
      if (!this.match(BacTokenKind.Comma)) { break; }
    }
    return true;
  }

  private tryParseGenericCallArgs(): { typeArgs: ast.BacTypeRef[]; args: ast.BacCallArg[] } | undefined {
    const snapshot = this.save();
    if (!this.match(BacTokenKind.Lt)) { return undefined; }
    const typeArgs: ast.BacTypeRef[] = [];
    while (true) {
      if (!this.check(BacTokenKind.Identifier)) { this.restore(snapshot); return undefined; }
      const t = this.parseTypeRef();
      if (!t.baseName) { this.restore(snapshot); return undefined; }
      typeArgs.push(t);
      if (this.match(BacTokenKind.Comma)) { continue; }
      break;
    }
    if (!this.match(BacTokenKind.Gt))     { this.restore(snapshot); return undefined; }
    if (!this.check(BacTokenKind.LParen)) { this.restore(snapshot); return undefined; }
    this.advance(); // (
    const args: ast.BacCallArg[] = [];
    this.parseCallArgs(args);
    if (!this.match(BacTokenKind.RParen)) { this.restore(snapshot); return undefined; }
    return { typeArgs, args };
  }

  private parsePostfix(): ast.BacExpr | undefined {
    let result = this.parsePrimary();
    while (result) {
      const location = result.location;
      if (this.match(BacTokenKind.Dot)) {
        const memberName = this.expectIdentifier('member name');
        result = { kind: 'member_access', location, target: result, memberName, separator: '.' };
      } else if (this.check(BacTokenKind.Colon) && this.at(1).kind === BacTokenKind.Colon) {
        // `Foo::Bar` is a namespace access — enum literals (Enum_X::Y) and
        // cross-event pin references (PrimaryThumbstick::Axis_X). The
        // separator distinction is preserved on the AST so the validator can
        // discriminate the two cases and the formatter can round-trip the
        // original syntax. Two-colon lookahead because `:` alone is the
        // type-annotation colon used elsewhere.
        this.advance(); // first ':'
        this.advance(); // second ':'
        const memberName = this.expectIdentifier("member name after '::'");
        result = { kind: 'member_access', location, target: result, memberName, separator: '::' };
      } else if (this.match(BacTokenKind.LBracket)) {
        const index = this.parseExpr();
        if (!index) { return result; }
        this.expect(BacTokenKind.RBracket, "']' to close index");
        result = { kind: 'index', location, target: result, index };
      } else if (this.match(BacTokenKind.LParen)) {
        const args: ast.BacCallArg[] = [];
        this.parseCallArgs(args);
        this.skipNewlines();
        this.expect(BacTokenKind.RParen, "')' to close argument list");
        result = { kind: 'call', location, callee: result, args };
      } else if (this.check(BacTokenKind.Lt)) {
        const generic = this.tryParseGenericCallArgs();
        if (generic) {
          result = { kind: 'generic_call', location, callee: result,
                     typeArgs: generic.typeArgs, args: generic.args };
        } else {
          break;
        }
      } else if (this.match(BacTokenKind.Kw_As)) {
        const targetType = this.parseTypeRef();
        result = { kind: 'cast', location, source: result, targetType };
      } else {
        break;
      }
    }
    return result;
  }

  private parsePrimary(): ast.BacExpr | undefined {
    const location = this.current().location;
    const tok = this.current();
    switch (tok.kind) {
      case BacTokenKind.IntLit: {
        this.advance();
        // Decimal int. Hex/binary use the same lexeme but with a prefix.
        let raw = tok.lexeme;
        let value: bigint;
        try {
          if (raw.startsWith('0x') || raw.startsWith('0X')) { value = BigInt(raw); }
          else if (raw.startsWith('0b') || raw.startsWith('0B')) { value = BigInt('0b' + raw.slice(2)); }
          else { value = BigInt(raw); }
        } catch { value = 0n; }
        return { kind: 'int_lit', location, value };
      }
      case BacTokenKind.FloatLit: {
        this.advance();
        return { kind: 'float_lit', location, value: Number(tok.lexeme) };
      }
      case BacTokenKind.StringLit: {
        this.advance();
        let raw = tok.lexeme;
        if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
          raw = raw.slice(1, -1);
        }
        return { kind: 'string_lit', location, value: raw };
      }
      case BacTokenKind.Kw_True:  this.advance(); return { kind: 'bool_lit', location, value: true };
      case BacTokenKind.Kw_False: this.advance(); return { kind: 'bool_lit', location, value: false };
      case BacTokenKind.Kw_None:  this.advance(); return { kind: 'none_lit', location };
      case BacTokenKind.Kw_This:  this.advance(); return { kind: 'this',     location };
      case BacTokenKind.Kw_Super: this.advance(); return { kind: 'super',    location };
      case BacTokenKind.Identifier: {
        this.advance();
        return { kind: 'ident', location, name: tok.lexeme };
      }
      case BacTokenKind.LParen: {
        this.advance();
        const inner = this.parseExpr();
        this.expect(BacTokenKind.RParen, "')' to close parenthesized expression");
        return inner;
      }
      case BacTokenKind.Kw_Asset: {
        this.advance();
        this.expect(BacTokenKind.LParen, "'(' after 'asset'");
        let path = '';
        if (this.check(BacTokenKind.StringLit)) {
          let raw = this.current().lexeme;
          if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
            raw = raw.slice(1, -1);
          }
          path = raw;
          this.advance();
        } else {
          this.error("'asset(...)' expects a string literal path.", this.current().location, 'BAC1030');
        }
        this.expect(BacTokenKind.RParen, "')' to close 'asset(...)'");
        return { kind: 'asset', location, path };
      }
      case BacTokenKind.Kw_Default: {
        this.advance();
        this.expect(BacTokenKind.Lt, "'<' after 'default'");
        const typeArg = this.parseTypeRef();
        this.expect(BacTokenKind.Gt, "'>' to close 'default<...>'");
        this.expect(BacTokenKind.LParen, "'(' after 'default<T>'");
        this.expect(BacTokenKind.RParen, "')' to close 'default<T>()'");
        return { kind: 'default', location, typeArg };
      }
      default: {
        this.error(`Expected expression, got '${tokenKindName(tok.kind)}'.`,
          tok.location, 'BAC1040');
        this.advance();
        return undefined;
      }
    }
  }
}
