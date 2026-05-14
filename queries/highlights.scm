; Highlight queries for BAC.
; Capture-name conventions follow tree-sitter's standard scopes; the exact
; mapping into VS Code semantic tokens is done by the editor extension.
; Tree-sitter applies later patterns with HIGHER precedence — the catch-all
; identifier rule lives near the top so the specific cases below override it.

; ─── Catch-all identifier ──────────────────────────────────────────────────
(identifier) @variable

; ─── Keywords ──────────────────────────────────────────────────────────────
[
  "class"
  "implements"
  "import"
  "from"
  "var"
  "let"
  "function"
  "pure"
  "event"
  "component"
  "attach"
  "construction"
  "settings"
  "defaults"
  "ref"
  "const"
  "out"
] @keyword

[
  "if"
  "else"
  "for"
  "while"
  "in"
  "return"
  "as"
] @keyword.control

(break_statement)    @keyword.control
(continue_statement) @keyword.control

"await" @keyword.control.async

(this_expression)  @variable.builtin
(super_expression) @variable.builtin

[
  "asset"
  "default"
] @function.builtin

; ─── Literals ──────────────────────────────────────────────────────────────
(integer_literal) @number
(float_literal)   @number.float
(string_literal)  @string
(escape_sequence) @string.escape
(bool_literal)    @constant.builtin.boolean
(none_literal)    @constant.builtin

; ─── Operators / punctuation ───────────────────────────────────────────────
[
  "+" "-" "*" "/" "%"
  "==" "!=" "<" ">" "<=" ">="
  "&&" "||" "!"
  "=" "+=" "-=" "*=" "/=" "%="
] @operator

[
  "(" ")" "{" "}" "[" "]"
] @punctuation.bracket

[ "," "." ":" "@" ] @punctuation.delimiter

; ─── Comments ──────────────────────────────────────────────────────────────
(line_comment)  @comment
(block_comment) @comment

; ─── Class declaration ─────────────────────────────────────────────────────
(class_declaration
  name: (identifier) @type
  parent: (identifier)? @type)

(class_declaration
  interface: (identifier) @type)

; ─── Decorators ────────────────────────────────────────────────────────────
(decorator
  name: (identifier) @attribute)

(decorator_arg
  name: (identifier) @property)

; ─── Members ───────────────────────────────────────────────────────────────
(variable_decl
  name: (identifier) @variable.member)

(component_decl
  name: (identifier) @variable.member)

(component_decl
  attach_parent: (identifier) @variable.member)

(component_override_assignment
  name: (identifier) @property)

(function_decl
  name: (identifier) @function.method)

(function_decl
  interface: (identifier) @type
  interface_method: (identifier) @function.method)

(event_decl
  name: (identifier) @function.method)

(parameter
  name: (identifier) @variable.parameter)

; ─── Types ─────────────────────────────────────────────────────────────────
(type_ref
  base: (identifier) @type)

; Built-in primitive type names get the more specific @type.builtin scope.
((type_ref base: (identifier) @type.builtin)
 (#match? @type.builtin "^(bool|byte|int|int64|float|name|string|text|Class|SoftClass|SoftObject|Set|Map)$"))

; ─── Statements / expressions ──────────────────────────────────────────────
(if_let_binding
  binding: (identifier) @variable)

(for_statement
  binding: (identifier) @variable)

(var_decl_statement
  name: (identifier) @variable)

(let_decl_statement
  name: (identifier) @variable)

; Member access — receiver is just an identifier; the member name itself.
(member_access_expression
  member: (identifier) @property)

; Call callee in member-access form: highlight the rightmost identifier as a method call.
(call_expression
  callee: (member_access_expression
    member: (identifier) @function.method.call))

(generic_call_expression
  callee: (member_access_expression
    member: (identifier) @function.method.call))

; Bare-name call (PrintString, etc.) — the callee identifier is a function call.
(call_expression
  callee: (identifier) @function.call)

(generic_call_expression
  callee: (identifier) @function.call)

; Named-argument names highlight as parameter labels.
(call_arg
  name: (identifier) @variable.parameter)

(parameter
  name: (identifier) @variable.parameter)

; Asset literal path argument — render path text as a string with hint scope.
(asset_expression
  path: (string_literal) @string.special.path)

