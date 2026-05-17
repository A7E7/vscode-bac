// Tree-sitter grammar for BAC (Blueprint as Code).
//
// Mirrors the hand-written C++ parser in
//   Plugins/BlueprintAsCode/Source/BlueprintAsCodeCore/Private/Script/BacParser.cpp
// of the BlueprintAsCode plugin. Every named rule in this grammar lines up with
// a parse function in that file so that fixtures from `Plugins/.../Tests/Corpus/`
// can be used as parity oracle.

module.exports = grammar({
  name: 'bac',

  extras: $ => [
    /\s+/,
    $.line_comment,
    $.block_comment,
  ],

  word: $ => $.identifier,

  conflicts: $ => [
    // `<` after an expression can open either a less-than comparison or the
    // type-arg list of a generic_call_expression. The C++ parser does a
    // snapshot+backtrack; tree-sitter resolves it with a conflict declaration
    // so GLR carries both interpretations until the lookahead disambiguates.
    [$.binary_expression, $.unary_expression, $.generic_call_expression],
    [$.binary_expression, $.await_expression, $.generic_call_expression],
    // Inside a generic-call type-arg list, the very first identifier could
    // start a TypeRef or be a value expression — only the surrounding shape
    // (`>` then `(` for generic call vs `,`/`)` for less-than chained) tells
    // them apart.
    [$.type_ref, $._expression],
    // A bare `{}` inside a macro decl can be either an empty single-statement
    // block or an empty per-input body list. The C++ parser decides upfront
    // by inspecting whether `inputs (...)` was provided; tree-sitter can't
    // see that earlier choice once it's reducing the body, so let GLR carry
    // both interpretations until the surrounding context resolves it.
    [$.block, $.macro_input_body_list],
    // Inside a macro body, a leading identifier could either start an
    // expression-statement (`Identifier(...)` call) or a per-input body
    // block (`Identifier() { ... }`). Same disambiguation reason as above —
    // the choice depends on whether `inputs (...)` was present, which GLR
    // can determine once the surrounding macro_decl reduces.
    [$.macro_input_body_block, $._expression],
  ],

  precedences: $ => [
    [
      'unary',
      'cast',
      'mul',
      'add',
      'cmp',
      'and',
      'or',
      'assign',
    ],
    [
      'member_access',
      'call',
      'unary',
    ],
  ],

  rules: {
    // ─── Top level ────────────────────────────────────────────────────────
    source_file: $ => seq(
      repeat($.import_decl),
      repeat($.decorator),
      choice($.class_declaration, $.interface_declaration),
    ),

    import_decl: $ => seq(
      'import',
      '{',
      commaSep1($.identifier),
      '}',
      'from',
      $.string_literal,
    ),

    // ─── Decorators ───────────────────────────────────────────────────────
    decorator: $ => seq(
      '@',
      field('name', $._decorator_name),
      optional(seq(
        '(',
        optional(commaSep1($.decorator_arg)),
        ')',
      )),
    ),

    // Decorator names may collide with reserved keywords (e.g. `@event`,
    // `@const`). Tree-sitter promotes any string literal to a keyword
    // token once it appears in a rule; without this `choice` the keyword
    // tokens wouldn't match the identifier branch of a decorator name.
    _decorator_name: $ => choice(
      $.identifier,
      'event',
      'function',
      'default',
      'class',
      'var',
      'let',
      'pure',
      'const',  // function-level @const → FUNC_Const
    ),

    decorator_arg: $ => choice(
      seq(field('name', $.identifier), '=', field('value', $._expression)),
      field('value', $._expression),
    ),

    // ─── Class declaration ────────────────────────────────────────────────
    class_declaration: $ => seq(
      'class',
      field('name', $.identifier),
      optional(seq(
        ':',
        field('parent', $.identifier),
        optional(field('parent_qualified_path', $.qualified_path)),
      )),
      optional(seq(
        'implements',
        commaSep1(seq(
          field('interface', $.identifier),
          optional(field('interface_qualified_path', $.qualified_path)),
        )),
      )),
      field('body', $.class_body),
    ),

    // ─── Interface declaration ────────────────────────────────────────────
    // `interface IFoo { function Bar(args): Ret  event Baz(args) }` — Blueprint
    // Interface. Body holds method signatures only (function or event); no
    // var/component/defaults/settings — interfaces declare contracts, not state.
    interface_declaration: $ => seq(
      'interface',
      field('name', $.identifier),
      field('body', $.interface_body),
    ),

    interface_body: $ => seq(
      '{',
      repeat(choice($.function_decl, $.event_decl)),
      '}',
    ),

    class_body: $ => seq(
      '{',
      repeat($._class_member),
      '}',
    ),

    _class_member: $ => choice(
      $.variable_decl,
      $.component_decl,
      $.function_decl,
      $.event_decl,
      $.construction_decl,
      $.defaults_block,
      $.settings_block,
      $.timeline_decl,
      $.widget_decl,
      $.macro_decl,
    ),

    // `defaults { Property = Value … }` — class-scope CDO overrides. Each
    // assignment routes through FProperty::ImportText into the BPGC's class
    // default object on the engine side.
    defaults_block: $ => seq(
      'defaults',
      '{',
      repeat($.class_assignment),
      '}',
    ),

    // `settings { Property = Value … }` — UBlueprint asset metadata
    // (the editor's "Class Settings" panel). Body shape is identical to
    // `defaults`; the plugin dispatches on member kind to pick the
    // target (UBlueprint vs. CDO).
    settings_block: $ => seq(
      'settings',
      '{',
      repeat($.class_assignment),
      '}',
    ),

    // Property override LHS in defaults / settings blocks. Permits a
    // dotted path (`PrimaryActorTick.bStartWithTickEnabled`) so the
    // engine-side resolver can walk into FStructProperty layers.
    class_assignment: $ => seq(
      field('name', sep1($.identifier, '.')),
      '=',
      field('value', $._expression),
    ),

    // ─── Variable / component / function / event / construction ────────────
    variable_decl: $ => seq(
      repeat($.decorator),
      'var',
      field('name', $.identifier),
      ':',
      field('type', $.type_ref),
      optional(seq('=', field('default', $._expression))),
    ),

    component_decl: $ => seq(
      repeat($.decorator),
      'component',
      field('name', $.identifier),
      ':',
      field('type', $.type_ref),
      optional(seq('attach', field('attach_parent', $.identifier))),
      optional(field('overrides', $.component_overrides)),
    ),

    component_overrides: $ => seq(
      '{',
      repeat($.component_override_assignment),
      '}',
    ),

    component_override_assignment: $ => seq(
      field('name', $.identifier),
      '=',
      field('value', $._expression),
    ),

    function_decl: $ => seq(
      repeat($.decorator),
      optional('pure'),
      'function',
      field('name', $.identifier),
      '(',
      optional(commaSep1($.parameter)),
      ')',
      optional(seq(':', field('return_type', $.type_ref))),
      optional(seq(
        'implements',
        field('interface', $.identifier),
        '.',
        field('interface_method', $.identifier),
      )),
      field('body', $.block),
    ),

    event_decl: $ => seq(
      repeat($.decorator),
      'event',
      field('name', $.identifier),
      '(',
      optional(commaSep1($.parameter)),
      ')',
      field('body', $.block),
    ),

    construction_decl: $ => seq(
      repeat($.decorator),
      'construction',
      field('body', $.block),
    ),

    // `[pure] macro Name(params)[: Ret] { body }`
    //
    // Unified macro syntax: `:Exec`-typed params name the macro's exec
    // pins in declaration order. Non-`out` `:Exec` produces an input
    // exec pin (drives a body block); `out X: Exec` produces an output
    // exec pin (drivable by route calls). The `pure` modifier marks
    // macros with no exec pins (body is pin-flow only, like `pure
    // function`).
    //
    // Body has two shapes:
    //   • `{ stmts }`                                 — pure macro body
    //   • `{ Name() {stmts}  Name() {stmts}  … }`     — per-input bodies
    //                                                   (one per `:Exec` input
    //                                                   param, in declaration
    //                                                   order)
    macro_decl: $ => seq(
      repeat($.decorator),
      optional('pure'),
      'macro',
      field('name', $.identifier),
      '(',
      optional(commaSep1($.parameter)),
      ')',
      optional(seq(':', field('return_type', $.type_ref))),
      field('body', choice($.block, $.macro_input_body_list)),
    ),

    macro_input_body_list: $ => seq(
      '{',
      repeat($.macro_input_body_block),
      '}',
    ),

    macro_input_body_block: $ => seq(
      field('name', $.identifier),
      '(',
      ')',
      field('body', $.block),
    ),

    // `timeline X { setting = expr; track Name[: Type [= Source]]; event H() {} }`
    // — a UTimelineTemplate + its associated K2Node_Timeline. Settings target
    // scalar fields on the template (Length, LengthMode, AutoPlay, …); tracks
    // are data tracks (float / Vector / LinearColor with a curve source) or
    // bare event tracks; handlers (Update / Finished / per-event-track)
    // bind to the K2Node_Timeline's exec output pins.
    timeline_decl: $ => seq(
      repeat($.decorator),
      'timeline',
      field('name', $.identifier),
      '{',
      repeat(choice(
        $.timeline_setting,
        $.track_decl,
        $.event_decl,
      )),
      '}',
    ),

    timeline_setting: $ => seq(
      field('name', $.identifier),
      '=',
      field('value', $._expression),
    ),

    // UMG widget tree. Top-level form carries the `widget` keyword; the
    // body recursively contains:
    //   • static property overrides — `Name = expr`
    //   • UMG property bindings — `Name => Func` (the `=>` is the
    //     FatArrow token; plugin lowers it to `WBP->Bindings`)
    //   • child widgets — `Name: Type [{ body }]` (keyword-less, brace
    //     body optional for leaf widgets)
    // Mirrors `parseWidgetDecl` / `parseChildWidgetDecl` / `parseWidgetBody`
    // in `lsp/src/script/parser.ts` (lines 763-826) and `ParseWidgetDecl`
    // in the C++ plugin's `BacParser.cpp`.
    widget_decl: $ => seq(
      repeat($.decorator),
      'widget',
      field('name', $.identifier),
      ':',
      field('type', $.type_ref),
      field('body', $.widget_body),
    ),

    widget_body: $ => seq(
      '{',
      repeat(choice(
        $.widget_binding,
        $.widget_assignment,
        $.child_widget_decl,
      )),
      '}',
    ),

    child_widget_decl: $ => seq(
      field('name', $.identifier),
      ':',
      field('type', $.type_ref),
      optional(field('body', $.widget_body)),
    ),

    // `Name = expr` — static property override applied by the generator
    // via FProperty::ImportText. LHS permits a dotted path so `Slot.X`
    // routes the override to the widget's UPanelSlot.
    widget_assignment: $ => seq(
      field('name', sep1($.identifier, '.')),
      '=',
      field('value', $._expression),
    ),

    // `Name => FuncOrVar` — UMG property binding. Generator stamps a
    // FDelegateEditorBinding on the WidgetBlueprint and (for variable
    // RHS) synthesises a thin `__bac_bind_<Var>` pure wrapper that the
    // transcriber unwraps on round-trip.
    widget_binding: $ => seq(
      field('name', sep1($.identifier, '.')),
      '=>',
      field('value', $._expression),
    ),

    // Designer-named tracks frequently contain spaces ("Movement lerp",
    // "Lock rotation"); the quoted string-literal form is the round-trip-
    // faithful carrier (UE auto-derives the Update event's per-track param
    // by stripping non-identifier chars from the track name). Identifier
    // form stays primary for the common case.
    track_decl: $ => seq(
      'track',
      field('name', choice($.identifier, $.string_literal)),
      optional(seq(
        ':',
        field('type', $.type_ref),
        optional(seq('=', field('source', $._expression))),
      )),
    ),

    parameter: $ => seq(
      repeat($.decorator),
      // Optional `ref` / `const` / `out` modifiers — order is flexible.
      // `ref` / `const` modify an INPUT param: they set `bIsReference` /
      // `bIsConst` on the BP-side `FEdGraphPinType`, which UE compiles into
      // `CPF_ReferenceParm` / `CPF_ConstParm`. `out` marks an OUTPUT param
      // (UE `CPF_OutParm`) — a pin on the FunctionResult node. `out` is
      // mutually exclusive with `ref` / `const`; the plugin/LSP parser
      // rejects the combination (`BAC1041`).
      repeat(field('modifier', choice('ref', 'const', 'out'))),
      field('name', $.identifier),
      ':',
      field('type', $.type_ref),
      optional(seq('=', field('default', $._expression))),
    ),

    // ─── Types ────────────────────────────────────────────────────────────
    type_ref: $ => prec.right(seq(
      field('base', $.identifier),
      optional(seq('<', commaSep1($.type_ref), '>')),
      repeat(seq('[', ']')),
      optional(field('qualified_path', $.qualified_path)),
    )),

    // `@/Game/Foo/AssetName` — optional disambiguation suffix on a type or
    // class-name reference. Resolved by the plugin's BacTypeResolver against
    // the asset registry. The trailing `.AssetName[_C]` form is also accepted
    // for tolerance when authors paste full UE object paths.
    // Right-associative so the optional `.identifier` tail prefers being
    // absorbed into the qualified path over starting a member access on
    // whatever follows (the conflict surfaces in cast-expression position
    // like `expr as Type@/path.Asset.Member`).
    qualified_path: $ => prec.right(seq(
      '@',
      '/',
      $.identifier,
      repeat(seq('/', $.identifier)),
      optional(seq('.', $.identifier)),
    )),

    // ─── Statements ───────────────────────────────────────────────────────
    block: $ => seq('{', repeat($._statement), '}'),

    _statement: $ => choice(
      $.if_statement,
      $.while_statement,
      $.for_statement,
      $.return_statement,
      $.break_statement,
      $.continue_statement,
      $.reset_statement,
      $.var_decl_statement,
      $.let_decl_statement,
      $.assignment_statement,
      $.expression_statement,
      $.block,
    ),

    if_statement: $ => prec.right(seq(
      'if',
      '(',
      optional($.if_let_binding),
      field('condition', $._expression),
      ')',
      field('then', $.block),
      optional(seq(
        'else',
        field('else', choice($.if_statement, $.block)),
      )),
    )),

    if_let_binding: $ => seq(
      'let',
      field('binding', $.identifier),
      '=',
    ),

    while_statement: $ => seq(
      'while',
      '(',
      field('condition', $._expression),
      ')',
      field('body', $.block),
    ),

    for_statement: $ => seq(
      'for',
      '(',
      field('binding', $.identifier),
      optional(seq(':', field('binding_type', $.type_ref))),
      'in',
      field('iterable', $._expression),
      ')',
      field('body', $.block),
    ),

    return_statement: $ => prec.right(seq(
      'return',
      optional(field('value', $._expression)),
    )),

    break_statement: _ => 'break',
    continue_statement: _ => 'continue',

    // `reset <label>` — wires the current exec output into the multi-exec
    // K2Node labeled via `@<label>` elsewhere in the same class (typically
    // a MultiGate / DoOnce whose Reset exec input is fired from another
    // event or function). See the BAC plugin's `Roundtrip_ResetWire.bac`
    // for the canonical shape; full semantics in the plugin's CHANGELOG
    // under "Out-of-chain exec input wiring".
    reset_statement: $ => seq(
      'reset',
      field('label', $.identifier),
    ),

    var_decl_statement: $ => prec.right(seq(
      'var',
      field('name', $.identifier),
      optional(seq(':', field('type', $.type_ref))),
      optional(seq('=', field('initializer', $._expression))),
    )),

    let_decl_statement: $ => prec.right(seq(
      'let',
      field('name', $.identifier),
      optional(seq(':', field('type', $.type_ref))),
      optional(seq('=', field('initializer', $._expression))),
    )),

    assignment_statement: $ => prec.right('assign', seq(
      field('target', $._expression),
      field('op', choice('=', '+=', '-=', '*=', '/=', '%=')),
      field('value', $._expression),
    )),

    // Expression statements wrap any expression. Wrap in `prec.right` so
    // call/index/member-access continuations on a parenthesized expr at the
    // start of a statement bind to the call rather than splitting into two
    // statements.
    expression_statement: $ => prec.right(seq($._expression)),

    // ─── Expressions ──────────────────────────────────────────────────────
    _expression: $ => choice(
      $.binary_expression,
      $.unary_expression,
      $.cast_expression,
      $.await_expression,
      $.call_expression,
      $.generic_call_expression,
      $.index_expression,
      $.member_access_expression,
      $.parenthesized_expression,
      $.asset_expression,
      $.default_expression,
      $.this_expression,
      $.super_expression,
      $.identifier,
      $._literal,
    ),

    binary_expression: $ => choice(
      prec.left('or',  seq(field('left', $._expression), field('op', '||'), field('right', $._expression))),
      prec.left('and', seq(field('left', $._expression), field('op', '&&'), field('right', $._expression))),
      prec.left('cmp', seq(field('left', $._expression),
        field('op', choice('==', '!=', '<', '>', '<=', '>=')),
        field('right', $._expression))),
      prec.left('add', seq(field('left', $._expression),
        field('op', choice('+', '-')), field('right', $._expression))),
      prec.left('mul', seq(field('left', $._expression),
        field('op', choice('*', '/', '%')), field('right', $._expression))),
    ),

    unary_expression: $ => prec('unary', seq(
      field('op', choice('!', '-')),
      field('operand', $._expression),
    )),

    cast_expression: $ => prec.left('cast', seq(
      field('source', $._expression),
      'as',
      field('target_type', $.type_ref),
    )),

    await_expression: $ => prec.right('unary', seq(
      'await',
      field('inner', $._expression),
    )),

    call_expression: $ => prec('call', seq(
      field('callee', $._expression),
      '(',
      optional(commaSep1($.call_arg)),
      ')',
    )),

    generic_call_expression: $ => prec('call', seq(
      field('callee', $._expression),
      '<', commaSep1($.type_ref), '>',
      '(',
      optional(commaSep1($.call_arg)),
      ')',
    )),

    call_arg: $ => choice(
      seq(field('name', $.identifier), '=', field('value', $._expression)),
      field('value', $._expression),
    ),

    index_expression: $ => prec('member_access', seq(
      field('target', $._expression),
      '[',
      field('index', $._expression),
      ']',
    )),

    member_access_expression: $ => prec('member_access', seq(
      field('target', $._expression),
      field('separator', choice('.', '::')),
      field('member', $.identifier),
    )),

    parenthesized_expression: $ => seq(
      '(',
      $._expression,
      ')',
    ),

    asset_expression: $ => seq(
      'asset',
      '(',
      field('path', $.string_literal),
      ')',
    ),

    default_expression: $ => seq(
      'default',
      '<', field('type', $.type_ref), '>',
      '(', ')',
    ),

    this_expression:  _ => 'this',
    super_expression: _ => 'super',

    // ─── Literals ─────────────────────────────────────────────────────────
    _literal: $ => choice(
      $.integer_literal,
      $.float_literal,
      $.string_literal,
      $.bool_literal,
      $.none_literal,
    ),

    integer_literal: _ => /-?\d+/,
    float_literal:   _ => /-?\d+\.\d+([eE][+-]?\d+)?/,
    string_literal:  $ => seq(
      '"',
      repeat(choice(
        $.escape_sequence,
        token.immediate(prec(1, /[^"\\\n]+/)),
      )),
      '"',
    ),
    escape_sequence: _ => token.immediate(/\\[\\nrt"'0]/),
    bool_literal:    _ => choice('true', 'false'),
    none_literal:    _ => 'none',

    // ─── Identifiers ──────────────────────────────────────────────────────
    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    // ─── Comments ─────────────────────────────────────────────────────────
    line_comment:  _ => token(seq('//', /[^\r\n]*/)),
    block_comment: _ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});

function commaSep1(rule) {
  // Trailing comma allowed (C++ parser bails out at RParen even after a comma).
  return seq(rule, repeat(seq(',', rule)), optional(','));
}

function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}
