# Changelog

All notable changes to **vscode-bac** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/).

This changelog tracks the public extension + LSP. Plugin-side changes
(generator, transcriber, validator passes) live in
[BlueprintAsCode/CHANGELOG.md](https://github.com/A7E7/BlueprintAsCode) — the
repos move in lockstep when their interfaces change (diagnostic JSON, the
`bac.lint` command line, the completion server NDJSON protocol).

## [Unreleased]

### Removed — BAC2240 `@replicated requires bReplicates=true`

Mirrors the plugin-side removal (see
[`BlueprintAsCode/CHANGELOG.md`](https://github.com/A7E7/BlueprintAsCode/blob/main/CHANGELOG.md)
for the full rationale — runtime `SetReplicates` and engine-version
drift made the static heuristic produce too many false positives).

LSP side:
- `checkReplicationConsistency` plus `classDeclaresReplication` /
  `decoratorImpliesReplication` helpers removed from
  [`lsp/src/validate/contract-check.ts`](lsp/src/validate/contract-check.ts).
- Fixture `Validate_ReplicatedWithoutClass.bac` and its
  `parity_manifest.json` entry deleted from
  [`test/parity-corpus/Tests/Corpus/`](test/parity-corpus/Tests/Corpus/).
- The BAC2240 example in the code-actions comment is replaced with a
  generic anchor-window example.

Wire-stable contract note: the diagnostic code `BAC2240` is retired —
do not reuse it for a new check. AI agents pattern-matching on the old
semantics will silently drop the case rather than misroute.

### Added — `@/Game/Path/Asset` qualifier on type-position references

Optional inline qualifier disambiguating short-name collisions across
packages. Lands atomically with the plugin-side addition (see
`BlueprintAsCode/CHANGELOG.md` for resolver / transcriber details and
the new `BAC2352` diagnostic).

LSP / parser surface:
- `BacTypeRef.qualifiedPath?: string` and `BacClassDecl.parentQualifiedPath`
  / `interfaceQualifiedPaths` and `BacAssetDecl.parentQualifiedPath`
  added to [`lsp/src/script/ast.ts`](lsp/src/script/ast.ts) — 1:1 with
  the C++ AST changes.
- [`lsp/src/script/parser.ts`](lsp/src/script/parser.ts) gets
  `parseOptionalQualifiedPath()` and threads it through
  `parseTypeRef`, `parseClassDecl` (parent + interface list), and
  `parseAssetDecl`.
- Formatter [`lsp/src/format/print.ts`](lsp/src/format/print.ts)
  emits the `@path` suffix inline (no break) on types, parent class,
  interface list, asset parent.
- Tree-sitter [`grammar.js`](grammar.js) gets a `qualified_path` rule
  (right-associative so the optional `.AssetName` tail is absorbed
  into the path rather than starting a member access). `type_ref`
  and `class_declaration` accept the qualifier in parent / interface /
  type positions. New corpus case in
  [`test/corpus/classes.txt`](test/corpus/classes.txt).

The `@` token was already lexed (decorators use it); no token-table
changes. Bare short names still parse as before, so the addition is
fully backwards-compatible for existing `.bac` content.

### Added — `@override` decorator (zero-arg, function-like target)

Mirrors the plugin-side addition. `.bac` now requires `@override` on
every function or event that overrides a parent UFunction or
implements an interface method — same posture as the required `await`
at latent call sites: strictly enforced, transcriber always emits.
Aligns with TypeScript / C# / Java conventions and closes a silent
failure mode where a typo in a function name produced a brand-new
function instead of an override.

LSP-side: `ZERO_ARG_DECORATORS` in `lsp/src/validate/contract-check.ts`
gains an `override` entry (target = function-like). Shape validation
(arity 0, correct target) runs in the LSP on every keystroke;
semantic enforcement (presence iff a parent / interface member exists)
is engine-coupled and runs in the plugin's `BacIdentifierCheck` on
save via `bac.lint`.

If you keep a local stable-code reference, add:
- `BAC2350` — function / event overrides a parent or interface
  member but `@override` is missing
- `BAC2351` — `@override` decorator on a function / event with no
  matching parent or implemented-interface member

### Added — Plugin-side `BAC2115` / `BAC2116` diagnostic codes (`@dynamic` decorator shape)

Plugin mirror — the contract-pass validator now recognises the
`@dynamic("<template-name>")` decorator that the transcriber emits for
`K2Node_AddComponent` dynamic-spawn templates (UActorComponent
archetypes living on `UBlueprint::ComponentTemplates` rather than the
SCS tree). Without the branch, validator pass produced
`BAC2199 Unknown decorator @dynamic` on every round-tripped dynamic
component — noisy and broke "validator-clean" gating in tooling that
consumes the LSP's diagnostic stream.

LSP-side: no code change required. The TS validator port runs the same
allowlist via the diagnostic codes wire. If you keep a local
stable-code reference (some agent prompts do), add:
- `BAC2115` — `@dynamic` wrong arity
- `BAC2116` — `@dynamic` arg must be a string literal

### Added — `reset <label>` keyword + `@<label>` multi-exec postfix (out-of-chain exec input wiring)

Mirrors the plugin-side addition. `.bac` can now reference multi-exec
K2Nodes (MultiGate, DoOnce, …) across exec chains via a class-wide
label tag:

```bac
event OnStart() {
  MultiGate(...)@gate { Out0() {...} Out1() {...} }
}
event OnReset() {
  reset gate     // wires this exec output into gate's Reset pin
}
```

- **Tree-sitter grammar** — new `reset_statement` rule plus `reset`
  reserved word; new `Reset statement` corpus entry passes.
- **LSP parser + AST** — new `BacResetStmt { kind: 'reset',
  targetLabel: string }`; `Kw_Reset` token. The multi-exec call body
  (`Call(...)@<label> { branches }`) still isn't fully parsed
  LSP-side (mirror lag), but the new keyword is captured so syntax
  highlighting / navigation work; semantic resolution happens
  plugin-side at generate time.
- **Formatter** (`format/print.ts`) — `reset` statement reprints as
  `reset <label>`.

See [BlueprintAsCode/CHANGELOG.md](https://github.com/A7E7/BlueprintAsCode)
for the generator-side label registry, the transcribe-side
auto-labeling pre-pass, and the `BAC1016` / `BAC1017` / `BAC3149`
diagnostics.

### Added — `interface` keyword (BPTYPE_Interface authoring)

`.bac` now supports a top-level `interface IFoo { … }` declaration that
mirrors the plugin-side addition. Body holds method signatures only —
`function Bar(args): Ret {}` and `event Baz(args) {}` — with all other
member kinds rejected as **BAC1015** ("Only 'function' or 'event'
declarations are allowed in an interface body"). No parent class or
`implements` clause is permitted on the interface itself; UE auto-parents
the resulting Blueprint to `UInterface`.

The `event` vs `function` keyword choice in the interface body drives the
implementor's override shape: `event` declarations carry
`FUNC_BlueprintEvent` (BlueprintImplementableEvent — impl in a class body
must use `event`); `function` declarations are plain BlueprintCallable
(impl uses `function`).

LSP changes that land in lockstep with the plugin side:
- `Kw_Interface` lexer token + keyword (`token.ts`).
- `BacInterfaceDecl` AST node + `interface?: BacInterfaceDecl` field on
  `BacScriptAst` (`ast.ts`).
- `parseInterfaceDecl` + top-level dispatcher branch (`parser.ts`).
- Top-level error message at **BAC1010** now lists `'interface'`.
- Tree-sitter grammar (`grammar.js`): new `interface_declaration` /
  `interface_body` rules alongside `class_declaration`.

### Changed — Diagnostic-code registry: `BAC3143` (widget animation collision)
New info-level code surfaced by the engine-coupled lint path on the
plugin side. Fires when a `UWidgetBlueprint` carries a `UWidgetAnimation`
whose name collides with a script-side event/function/macro of the same
name — the dupe-regen path drops the animation pre-compile (animations
aren't yet round-tripped, so this is consistent with existing
lossiness). No LSP-side code change; surfaced through the existing
`bac.lint` diagnostic envelope. See
[BlueprintAsCode CHANGELOG](https://github.com/A7E7/BlueprintAsCode/blob/main/CHANGELOG.md#unreleased)
for the engine-side detail.

### Added — Parity with BlueprintAsCode property-panel round-trip work
- **Param modifiers `ref` / `const`** on function / event / macro
  parameters: `function ApplyDelta(ref hp: float, const Source: Actor)`.
  Order is flexible (`ref const x` and `const ref x` both parse).
  Mirrors the C++ side at `BacParser.cpp::ParseParam`.
  * `lsp/src/script/token.ts` — added `Kw_Ref` / `Kw_Const` enum members
    and the lexeme entries in `KW_NAMES`.
  * `lsp/src/script/parser.ts` — `parseParam` consumes the modifiers and
    sets `bIsByRef` / `bIsConst` on `BacParam`.
  * `lsp/src/script/ast.ts` — `BacParam` carries the two flags.
  * `grammar.js` — parameter rule accepts `repeat(field('modifier',
    choice('ref', 'const')))` after decorators. `'const'` joins the
    `_decorator_name` choice list because `@const` is a valid
    function-level decorator and tree-sitter promotes string literals to
    keyword tokens once they appear in any rule.
  * `queries/highlights.scm` — `ref` / `const` highlighted as keywords.
  * `editors/code/syntaxes/bac.tmLanguage.json` — `ref` / `const` get
    the `storage.modifier.bac` scope inside the member-keywords block.
- **Full decorator surface in `contract-check.ts`** — replaces the old
  switch with catalog-driven dispatch matching
  `Plugins/.../Validate/BacContractCheck.cpp` line for line:
  * Zero-arg flag decorators on `var` only: `@editable`, `@readonly`,
    `@expose_on_spawn`, `@private`, `@interp`, `@config`, `@transient`,
    `@savegame`, `@advanced_display`.
  * Zero-arg flag decorators on `function` only: `@const`, `@exec`.
  * Zero-arg flag decorators on `function` + `event` + `macro`:
    `@thread_safe`, `@unsafe_during_actor_construction`,
    `@call_in_editor`.
  * `@deprecated` accepts var | function | event | macro (different
    storage per target, but the LSP only checks shape).
  * One-positional-string-lit metadata decorators: `@tooltip`,
    `@deprecation_message`, `@category` accept all four targets;
    `@keywords` and `@compact_node_title` accept function | event |
    macro.
  * `@display(...)` accepts var | function | event | macro.
  * `@access(public | protected | private)` accepts function only.
  * `@meta(Key="value", ...)` accepts var | function | event | macro.
  * `@replicated` grows a `condition = <Name>` named arg drawn from the
    `ELifetimeCondition` allowlist (no `COND_` prefix).
- **Target bitmasks**: `TARGET_VAR | TARGET_FN | TARGET_EVT | TARGET_MAC`,
  with `TARGET_FN_LIKE` and `TARGET_ALL_DECLS` shorthands. Each catalog
  entry carries a `targetMask`; `targetMaskToList` builds the
  wrong-target diagnostic message dynamically.
- The catalog dispatch eliminates the previous warning storm
  (`BAC2199 Unknown decorator @…`) on the LSP side that was visible
  while the C++ surface had advanced past the LSP. The two
  implementations are now in sync for the variable + function +
  event + macro decorator surface.

### Removed — `@replicated_default` decorator (lockstep with plugin)
- The class-level `@replicated_default(replicates=true)` decorator no longer
  exists. Replication now lives in the `defaults { bReplicates = true }`
  block — the same surface as every other CDO override. Coordinated with
  the BlueprintAsCode plugin (parser, generator, transcriber, validator).
- **Validator (BAC2240)**: `@replicated`, `@runson`, and `@event(runson=…)`
  members now require the class's `defaults` block to set
  `bReplicates = true`. Diagnostic message and quick-fix string updated to
  point at the defaults block instead of the (gone) decorator. The
  code-action handler that previously inserted the decorator above the
  class is retired (the new fix needs to insert into / create a defaults
  block — left as a hint string for now).
- **Snippet** `classrep` rewritten to expand into the defaults-block form.
  **Tree-sitter corpus**: the "Replicated class with RepNotify var" test now
  uses the defaults block.
- **Wire-stable contract**: `.bac` grammar accepted by `BacScriptParser` /
  `BacLexer` / `BacParser` (and the TS mirror) no longer accepts
  `@replicated_default`.

### Added — Asset / table body completion routes through the engine proxy (gap 7.1)
- `findScopeAt` carries two new optional fields: `assetContext.parentTypeName`
  and `rowContext.rowStructName`. When the cursor sits inside an
  `asset Foo : ParentClass { … }` body, `buildCompletionItemsAsync` calls
  `proxy.completeType(parentClass)` and surfaces the editable property
  surface (UFunctions are dropped in this position — they're not
  assignable). When inside a `row "Name" { … }` body of a `table … :
  RowStruct`, it calls `proxy.completeStruct(rowStruct)` and surfaces
  the row's fields. Both pipelines reuse the existing NDJSON ops and
  `BacEditorEndpoint.json` discovery — no wire change.
- `enginePropertiesToItems` and `engineStructFieldsToItems` are the new
  field-only converters; the existing `engineMembersToItems` (which
  emits both functions and properties) keeps serving member-access
  completion. No prefix gating in asset / row contexts since each body
  is a small finite list — the empty-prefix "show me everything" query
  is the common case there.

### Added — Definition / references cover struct, asset, and table top-level decls (gap 7.2)
- `findDefinition` no longer early-returns when `ast.class` is missing.
  It now falls through to `ast.struct` (jump to a field), `ast.asset`
  (jump to an assignment LHS), and `ast.table` (jump to a row name or a
  per-row assignment LHS). F12 inside a struct / asset / table file
  finally lands somewhere instead of returning null.
- `collectHits` walks struct fields, asset assignments, and table rows +
  their assignments so Find References / Document Highlights surface in
  those files too. Asset's `parentTypeName` and table's `rowStructName`
  count as `read` hits on the header.

### Fixed — Diagnostic squiggles cover the offending token, not just the first letter
- The `bac.lint` JSON wire shape carried only a single `{line, column, offset}`
  per diagnostic, so every red/yellow underline was synthesized at exactly
  one column wide regardless of what the diagnostic referred to. Fixed in
  two layers, both in `lsp/src/server.ts`:
  1. **Word-widening fallback.** When no end position is supplied, the LSP
     reads the document text and widens the start to the end of the
     identifier or keyword at that point (`endOfWordAt`). Operator-only
     points fall through to the prior 1-character range. Applies to both
     pipelines — engine (`toLspDiagnostic`) and AST
     (`toLspDiagnosticFromBac`).
  2. **Engine-supplied end.** `BacDiagnostic_LintWire` now accepts optional
     `endLine` / `endColumn` / `endOffset` (and the same on `notes[]`). When
     present they take priority over the fallback. The plugin populates
     these for parser-emitted diagnostics this slice; validator AST sites
     follow incrementally. Wire change is fully backward-compatible —
     older plugin builds keep working via the fallback path.

### Added — `settings`, `defaults`, `macro` highlighted as keywords
- TextMate grammar (`editors/code/syntaxes/bac.tmLanguage.json`): added
  `settings` and `defaults` to `keyword.other.bac`; added a `macro Name`
  rule mirroring `function`/`event` so the macro name picks up
  `entity.name.function.bac`.
- Tree-sitter highlight query (`queries/highlights.scm`): added `settings`
  and `defaults` to the `@keyword` group. (`macro` not yet added — the
  tree-sitter grammar doesn't define a `macro_decl` rule; that's a
  follow-up that needs grammar changes + LSP TS parser mirror.)

### Added — `settings { … }` keyword (lockstep grammar change)
- New `settings` keyword + `settings_block` rule in `grammar.js`
  (tree-sitter), `Kw_Settings` token + `parseSettingsBlock` in the LSP TS
  parser. Mirrors the plugin-side `Kw_Settings` / `FBacSettingsBlock`
  introduced in BlueprintAsCode this slice — the plugin replaced the
  seven hand-listed `@blueprint_*` decorators with a reflective
  `settings { Property = Value }` block parallel to `defaults`,
  auto-covering every UBlueprint metadata field the editor's "Class
  Settings" panel surfaces.
- Tree-sitter corpus: two new fixtures in `test/corpus/classes.txt` —
  "Class with defaults block" (filling a long-standing grammar gap; the
  rule existed in the LSP TS port but not in the tree-sitter grammar)
  and "Class with settings block".
- LSP TS hover / definition / references / symbols / contract-check all
  recognise the new member kind. Grammar mirrors confirmed by
  `npx tree-sitter test` (9/9) and `npm run parity` (14/14).
- Diagnostic codes / `bac.lint` JSON / completion-server NDJSON
  unchanged.

### Added — Class Settings + Class Defaults round-trip (plugin side)
- New class-level decorators recognised by the plugin generator /
  transcriber pair: `@blueprint_display`, `@blueprint_description`,
  `@blueprint_category`, `@blueprint_namespace`, `@blueprint_abstract`,
  `@blueprint_const`, `@blueprint_deprecated`. Each maps to a UBlueprint
  metadata field exposed in the editor's "Class Settings" panel.
- `defaults { PrimaryActorTick.bStartWithTickEnabled = false }` — dot-
  paths into nested CDO struct fields now round-trip. The grammar
  already accepted dotted assignment LHSes (the existing widget-slot
  syntax `Slot.Anchors = …` exercises the same parser path); the new
  bridge is in the plugin's generator and transcriber.
- LSP / grammar: **no change required**. The decorator surface stays
  permissive (`@<name>(<args>)` with arbitrary identifiers), the
  defaults-block already accepts dotted LHSes, and the `implements`
  clause was wired through the parser since v0.1. Stable-code list and
  diagnostic shape are unchanged. Documenting here so the lockstep
  invariant stays explicit.

### Added — Document symbols + hover + formatter for `struct` / `asset` / `table` documents
- LSP passes that previously no-op'd on non-class documents now provide
  meaningful results:
  - **Document symbols** (Outline view + breadcrumbs): struct → fields,
    asset → property assignments, table → rows → property assignments.
    Each level has the right `SymbolKind` (Struct / Field / Object /
    Property) so the IDE icons match.
  - **Hover**: hovering over a struct field name shows
    `var X: Type`. Hovering over an asset property name shows
    `property X on ParentClass`. Hovering over a table row name shows
    `row "X" (N property overrides)`; hovering over a property inside
    a row body shows `property X on row "Y"`.
  - **Formatter**: `printBacRoot` now routes to `printStruct` /
    `printAsset` / `printTable` when no `class` is present — non-class
    documents were getting their body silently dropped on format.
- LSP build clean, parity tests still 13/13 passing.

### Added — `table Foo : RowStruct { row "Name" { … } }` UDataTable documents (top-level keyword mirror)
- Top-level parser dispatch on `class` / `struct` / `asset` / `table`
  (the fourth shipping with this slice). Mirrors BAC plugin commit
  b71c597. New `Kw_Table` + `Kw_Row` lexer tokens, `BacTableDecl` /
  `BacTableRow` AST nodes, `parseTableDecl` method.
- IDE no longer flags `Roundtrip_Table.bac` (and similar table
  documents) with `BAC1010`. LSP passes already early-return when
  `ast.class` is missing, so a table-only document no-ops cleanly
  through every nav / validator pass.
- Engine side (already shipped): `IBacGenerator::GenerateTable` +
  `IBacTranscriber::TranscribeTable` + `RunRoundtripTable` helper +
  fixed-point name-mask extension to cover the `table` header.

### Added — `asset Foo : ParentClass { … }` UObject instance documents (top-level keyword mirror)
- Top-level parser dispatch on `class` / `struct` / `asset` (the third
  shipping with this slice). Mirrors BAC plugin commit f2ae7c4.
  Reuses the existing `Kw_Asset` token (already used inside expressions
  for `asset("/Game/...")` literals); the parser disambiguates by
  position. New `BacAssetDecl` AST node + `asset?` slot on
  `BacScriptAst`.
- IDE no longer flags `Roundtrip_Asset.bac` (and similar asset
  documents) with `BAC1010`.
- LSP passes already early-return when `ast.class` is missing, so an
  asset-only document no-ops cleanly through every navigation /
  validator pass. Hover / nav / completion polish for asset properties
  is a follow-up.
- Engine side (already shipped): `IBacGenerator::GenerateAsset` +
  `IBacTranscriber::TranscribeAsset` + `RunRoundtripAsset` helper +
  fixed-point name-mask extension to cover the `asset` header.

### Added — `struct Foo { … }` UUserDefinedStruct documents (top-level keyword mirror)
- New `Kw_Struct` token + `BacStructDecl` AST node + parser dispatch on
  `class` vs `struct` at the top level. Mirrors BAC plugin commit
  35bd35c. Struct bodies hold `var` field declarations only — same
  shape BP class variables use, no functions / events / components /
  macros / defaults.
- `BacScriptAst` grew a `struct?` slot alongside `class?`. LSP passes
  (navigation, hover, references, symbols, completion, contract-check,
  type-check, reference-check, formatter) all already early-return when
  `ast.class` is missing, so a struct-only document no-ops cleanly
  through every pass. Hover / nav / completion polish for struct fields
  is a follow-up.
- IDE no longer flags `Roundtrip_Struct.bac` (and similar struct
  documents) with `BAC1010` ("Expected 'class' declaration").
- Engine side (already shipped): generator routes each `var` field
  through `FStructureEditorUtils::AddVariable` + `RenameVariable` +
  `ChangeVariableDefaultValue`; transcriber walks `GetVarDesc` and emits
  one `var` line per field with the type + literal default.

### Added — `defaults { … }` class-scope CDO overrides (member-keyword mirror)
- New `Kw_Defaults` token + `BacDefaultsBlock` AST + `parseDefaultsBlock`
  mirroring the C++ parser. Body shape: `Property = Expression` per
  line, optional comma separator, terminated by `}` — same shape the
  component default-overrides body already uses.
- Navigation, hover, references, symbols, and contract-check all learn
  the new member kind so the IDE no longer flags `defaults { ... }` as
  `BAC1021` (wrong member kind). Defaults blocks are anonymous (no
  `name`) so they're filtered out of name-based lookups.
- Wire-stable mirror, atomic with BAC plugin commit badd525. Engine
  routes each assignment through `FProperty::ImportText_Direct` into
  the BPGC's class default object after compile; transcriber walks the
  CDO and emits any property diverging from the parent's default.

### Added — `@macro_library` class decorator (gap 1b Phase 1)
- Contract-check accepts `@macro_library` as a class-only zero-arg
  decorator alongside `@blueprintable`. The plugin generator flips
  `Blueprint->BlueprintType` to `BPTYPE_MacroLibrary` when present.
  Wire-stable, atomic with BAC plugin commit d902c12. Parity test
  unchanged at 13/16 PASS.

### Added — `macro` keyword (gap 1a Phase 1, declaration surface)
- New `Kw_Macro` token + `BacMacroDecl` AST + `parseMacroDecl` mirroring
  the function parser. The plugin generator stores macros on
  `Blueprint->MacroGraphs` and uses `UK2Node_Tunnel` terminators for
  the entry/exit. Phase 1 ships declaration only — non-empty bodies
  emit `BAC3145` (warning, body dropped) on the C++ side.
- Validators treat macro members as no-ops for Phase 1, same way the
  TS port handled `widget` initially. Hover formatter learns the
  `macro` arm.
- Wire-stable, atomic with BAC plugin commit b8b2ad3. Parity test
  unchanged at 13/16 PASS.

### Added — `::` enum-literal syntax (parser member-access)
- New: `Foo::Bar` parses as a member-access AST node, equivalent to
  `Foo.Bar`. The C++ enum-literal syntax everyone copies from familiarity
  (`EAttachmentRule::KeepRelative`, `ESlateVisibility::Visible`, …) now
  works without forcing users to write `EAttachmentRule.KeepRelative`.
  Two-token lookahead in `parsePostfix` disambiguates from the
  type-annotation colon. Wire-stable, atomic with BAC plugin commit
  f1b6b9c. Parity test 13/16 PASS unchanged.

### Added — UE-native container + soft-ref synonyms in `genericArity`
- `TArray`, `TSet`, `TMap`, `TSubclassOf`, `TSoftObjectPtr`, `TSoftClassPtr`
  now recognised as synonyms for `Set`, `Map`, `Class`, `SoftObject`,
  `SoftClass` (no `[]` equivalent for `TArray<T>` since the BAC form is
  `T[]`). The TS validator stops flagging `TArray<int>` etc. as unknown
  generics, matching the plugin's resolver. Wire-stable, atomic with
  the plugin commit.

### Added — code-action quick fixes for `add X before Y` + bidirectional anchor search
- `BAC2240` (replicated decorator missing class-level `@replicated_default`)
  was emitting a candidate fix the LSP couldn't translate to a clickable
  Quick Fix. The fix string follows an `add \`X\` before \`Y\`` shape that
  the original code-action handler didn't parse — silently dropped.
  Now produces a workspace insert that drops the new line above the
  anchor with matching indentation.
- `findInWindow` (the anchor locator) now searches a bidirectional
  4-line window around the diagnostic instead of forward-only. BAC2240
  fires on the `@replicated` line but its anchor (`class X`) sits one
  line above; the old forward-only search missed it. Closest occurrence
  to the diagnostic line wins on ambiguity.
- Smoke-tested both supported patterns end-to-end:
  - `BAC2200` (attach typo) → in-place replace, 0 regressions.
  - `BAC2240` → insert at line start, indent matches anchor's line.
- Parity test: 13/16 PASS (unchanged).

### Added — Widget Blueprint compatibility, Phase 4 (BindWidget + UMG events)
- New decorators `@bind_widget` and `@bind_widget_optional` accepted
  on var declarations by the contract-check pass. Mirrors the plugin
  side rules: var-only target, zero arguments. The plugin generator
  writes the matching metadata into the `FBPVariableDescription`'s
  `MetaDataArray` for UMG's auto-wire pass to consume.
- No AST shape change — decorators are already a `name + args` list,
  so adding two new accepted names is a one-line cases addition in
  the decorator switch.
- UMG event vocabulary (Construct, Tick, OnPaint, …) round-trips
  through the existing `event` path with no special case — the
  generator/transcriber resolve the parent UFUNCTION by name.
- UMG Animations deferred to Phase 4b — they're sub-assets and need
  a `.uasset` reference similar to Material Instance, not inline
  data.

### Added — Widget Blueprint compatibility, Phase 3 (property bindings)
- New `FatArrow` token (`=>`); lexer extends the `=` case to emit it.
  Wire-stable parser change atomic with BAC plugin commit. The plugin
  generator records each `=>` as a `FDelegateEditorBinding` on
  `UWidgetBlueprint::Bindings`.
- `BacAssignment` AST gains optional `isBinding: boolean` flag. The
  widget assignment parser sets it when it sees `=>`; the parser still
  accepts `=` for static overrides as before.
- New diagnostic codes reserved on the plugin side: `BAC3140`–
  `BAC3142` for binding errors. Surface via the existing
  `bac.sync.events` push channel like other `BAC3xxx` codes.
- v1 supports function bindings only (`Visibility => GetTitle`).
  Variable bindings defer to Phase 3b.

### Added — Widget Blueprint compatibility, Phase 2 (slot properties)
- Property-override names now accept dotted paths via the new
  `expectAssignmentName` helper. Wire-stable parser change atomic
  with the plugin side. The plugin splits names on the first dot to
  route `Slot.X` assignments to the widget's `UPanelSlot`.
- New diagnostic code reserved on the plugin side: `BAC3130` —
  `Slot.X` on a widget with no slot. Surfaces via the existing
  `bac.sync.events` push channel.
- No AST shape change — the dotted name is stored verbatim in
  `BacAssignment.name`. Validators and navigation continue to treat
  it as a single string for now; per-token highlighting of the dotted
  path can be a follow-up if it matters.

### Added — Widget Blueprint compatibility, Phase 1 (`widget` keyword)
- New `Kw_Widget` token + `BacWidgetDecl` AST + `parseWidgetDecl`
  recursive parser to mirror the plugin's Phase 1 widget-tree support.
  Children use the bare `Name: Type { ... }` form; property overrides
  and child widgets interleave inside the body.
- Wire-stable: lexer + parser + AST changed atomically with the plugin
  side. The validator passes (Contract / Reference / Type) treat
  `widget` members as no-ops for v1 — no per-construct widget-tree
  validation in the TS port yet (the plugin's generator does it via
  reflection at lower-time).
- Hover `formatClassMember` learns the new `widget` arm.
- Diagnostic codes reserved on the plugin side: `BAC3121–BAC3129`
  (widget-tree lowering errors). The LSP surfaces them via the
  existing `bac.sync.events` push channel like other `BAC3xxx` codes.
- Phases 2 (slot properties), 3 (bindings), 4 (BindWidget + events +
  animations) are tracked as gap **6** in the plugin's ROADMAP.

### Added — wire-stable exec command `bac.sync.resolve` (gap 5)
- New plugin-side exec command opens a side-by-side `.bac` vs canonical
  diff dialog in the UE editor for the named asset. The LSP can wire
  this to a "Resolve" code action on `BAC2410` diagnostics — `code
  action title: "Open conflict resolver"`, command:
  `UnrealEditor-Cmd <project> -ExecCmds="bac.sync.resolve <AssetPath>, Quit"`.
- Cross-repo follow-up: surface the action in `lsp/src/navigation/code-actions.ts`
  next time we touch it. Today the user can already run the command
  from the editor console; the LSP plumbing is convenience, not a
  blocker.

### Added — wire-stable diagnostic code `BAC3100` (partial regeneration applied)
- Reserved on the plugin side (gap 4 foundation). Surfaced by the
  watcher's `bac.sync.events` push channel when the generator returns a
  Partial result — i.e. some `.bac` constructs failed to lower but the
  rest synthesised, and the watcher applied the best-effort BP rather
  than dropping the whole sync. The LSP already plumbs `BAC3xxx` codes
  through `engine-proxy`'s sync-events path; no client change needed
  beyond surfacing the new code in the Problems panel like the
  `BAC24xx` siblings.

### Added — Validator parity test (gap 3, TS side)
- New `lsp/src/validate/parity-test.ts` consumes
  `Tests/Corpus/parity_manifest.json` from the BlueprintAsCode plugin
  repo (resolved via `BAC_PLUGIN_ROOT` env var, CLI arg, or sibling-repo
  default) and asserts the TS validator's diagnostic counts match every
  shared fixture.
- New `npm run parity` script wraps `tsc` + the runner.
- 13 of 16 manifest entries verified in lockstep on the TS side
  (AstOnly). The 3 `AstOnly+Identifiers` entries are skipped — the
  identifier-resolution pass needs UE reflection that lives only in the
  plugin's C++ pipeline. C++ counterpart is the `BAC.Validate.ParityManifest`
  automation test in the plugin repo.
- Wire-stable contract: any new shared `Validate_*.bac` fixture means
  one new manifest entry on the plugin side and a passing run of
  `npm run parity` on this side.

### Added — Struct schema reflection (`completeStruct` engine-proxy method)
- New proxy method consumes the plugin's `complete-struct` NDJSON op so
  the LSP can introspect any `UScriptStruct` (built-in or user-defined).
  Negative cache keyed on the struct name avoids re-querying for normal
  function calls that look like type names — first probe finalises.
- **Signature help** for struct-literal calls — typing `Vector(<TAB>` /
  `Box(<TAB>` / any user-defined struct constructor surfaces the field
  list as a parameter signature with field types + UE tooltips. Matches
  the existing UFUNCTION signature path; struct probe runs first because
  struct names and function names share a flat namespace and the schema
  is what users want hints for.
- Wire-stable contract: matches the plugin's `complete-struct` shape;
  diverging would silently break field hints.

### Changed — sync diagnostic accumulation
- The LSP now stores sync diagnostics per `(URI, code)` instead of one
  per URI. Two real cases drove this:
  - `BAC2410` (conflict) and `BAC2440` (fidelity gap) co-exist on the
    same `.bac` — both should be visible at once.
  - `BAC2401` (applied) means "the conflict was resolved" — it now
    clears only the `BAC2410` entry, leaving the persistent fidelity
    warnings in place.

### Added — BP ↔ .bac sync (LSP-side)
- `BacEngineProxy` learned a push-channel handler: any line received
  whose shape is `{ "event": "...", "payload": {...} }` (no `id`) is
  routed to a callback rather than treated as a request response.
- New `onSyncEvent` proxy option: server-pushed `bac.sync` events
  (BAC2401 applied / BAC2410 conflict / BAC2430 orphan / etc.) get
  surfaced as file-level diagnostics on the matching `.bac` URI when the
  plugin includes a `bacPath` in the payload. `BAC2401` (applied) clears
  any prior sync diagnostic on the URI — it's "we fixed it" not a
  persistent problem. **Wire-stable contract** — coordinated with the
  plugin's `BacCompletionServer` push channel.

### Added — IDE features (LSP)
- **Signature help** — parameter hints inside an open call (`(` opens, `,`
  advances active parameter). Resolves script-defined functions/events
  directly; for engine UFUNCTIONs (receiver of known type or unqualified
  call against the parent class) consults the engine proxy.
- **Code actions / quick fixes** — diagnostic `fixes` are surfaced as
  clickable VS Code quick-fixes (lightbulb menu). Parses
  ``replace `X` with `Y` `` patterns into `TextEdit`s; offers them with
  `isPreferred: true` so a single keystroke applies them.
- **Top-level partial completion** now also offers parent-class
  BlueprintCallable functions and visible properties — typing `S` suggests
  `SetActorLocation`, `SetActorHiddenInGame`, etc., merged with the script
  symbol list. Skipped on empty prefix to avoid dumping every inherited
  member into the menu.
- **Formatter** — opinionated `.bac` formatter via Prettier's doc IR.
  Locked style (no config knobs): 2-space indent, 80-char width, no
  semicolons, decorators on their own line, trailing commas on multi-line
  arg/param lists, imports source-path alphabetical, calls/binary chains
  break only when they don't fit. **Idempotent**: `format(format(x)) === format(x)`.
- **`documentFormattingProvider` + `documentRangeFormattingProvider`** —
  format-on-save / Format Document / Format Selection in VS Code with zero
  config; the LSP runs the formatter in-process.
- **`--format <file>` CLI mode** — one-shot formatter for pre-commit hooks,
  CI, AI agent loops. Prints formatted output to stdout, exit 0 always.

### Changed
- LSP attaches a `BacDiagnosticData` payload (`{ hint, fixes }`) to
  published `Diagnostic.data` so the code-action handler can resurrect the
  original fix list without re-running validators.
- Added `prettier` runtime dep to the LSP package; bundled into the VSIX
  (≈3 MB total now).

### Added — Standalone packaging
- **`prettier-plugin-bac`** publishable Prettier plugin lives in a
  [sibling repo](https://github.com/A7E7/prettier-plugin-bac) and re-exports
  the formatter for use outside the LSP. Same code as the LSP formatter
  (its build copies the compiled JS from `lsp/out/{script,format}/`), no
  divergence risk.

### Wire-stable contracts (additions)
- `Diagnostic.data: { hint?: string, fixes?: string[] }` — present on AST
  pass and engine pass diagnostics that carry hints/fixes. Consumed by the
  code-action handler.
- `formatBacText(source: string, options?) → string` — public entry point in
  `lsp/src/format/format.ts`; re-exported from the standalone npm package.
- The opinionated formatter style (above) is itself wire-stable: any change
  to the canonical output shape is a major version bump.

## [0.4.0] — 2026-05-08

This release captures the shipped state at the time the changelog was started.
Earlier versions (≤ 0.3.x) shipped via VSIX install only and aren't enumerated
retroactively.

### Added — Editor surface
- Tree-sitter grammar covering 68/68 BlueprintAsCode corpus fixtures + the
  `HealthPickup.bac` example
- TextMate grammar for VS Code highlighting (works in Cursor too)
- Tree-sitter highlight queries (Helix / Neovim / Zed)
- Language configuration (comments, brackets, auto-indent, surround pairs)
- Snippets (class / function / event / component / if-let / for-each / await /
  RepNotify)

### Added — Diagnostics
- TypeScript port of the C++ AST-only validator passes:
  contract / reference / type. Runs on every keystroke (50 ms debounce).
  12/12 `Validate_*` corpus fixtures emit the expected BAC codes.
- LSP wraps the plugin's `bac.lint` UE exec command on save and merges
  engine-coupled diagnostics with the TS-side stream, deduped by
  `code|line|col`.
- Auto-detect `.uproject` from workspace folders; explicit `bac.projectPath`
  setting and `BAC_PROJECT_PATH` env var both still win.

### Added — IDE features (LSP)
- **Completion** — TS-side identifier completion at keystroke time
  (params, locals, components, vars, script funcs/events). Engine-coupled
  member access (`Mesh.<TAB>`) queries the running editor through a local
  TCP socket and lists the receiver's BlueprintCallable functions +
  Blueprint-visible properties. Falls back to TS-only when no editor is open.
- **Hover** — markdown popup with type info, decorators, and function
  signatures; engine UFUNCTIONs/UPROPERTYs include their UE tooltips.
- **Goto Definition** — F12 / Cmd-click navigates to params, locals, and
  class members.
- **Document Symbols** — outline view + breadcrumb show class structure.
- **Find References** — Shift+F12 locates all uses, distinguishing
  reads / writes / decls.
- **Document Highlight** — soft highlights of every same-name occurrence
  as the cursor moves.

### Added — CI / agents
- `--once` CLI mode: full validator including the engine-coupled
  `bac.lint` UE roundtrip (~5 s).
- `--once-no-engine` CLI mode: TS-only validator passes, ~80 ms cold.
  Best for AI agent loops without a UE install.

### Wire-stable contracts
The following are part of this release's external surface and won't change
without a major version bump:

- Diagnostic JSON shape from `--once` / `--once-no-engine`:
  `{ ok, mode?, diagnostics: [{ severity, code, message, line, column, offset, hint?, fixes?, notes? }] }`
- Diagnostic codes (`BAC1xxx` parser, `BAC22xx` reference, `BAC23xx`
  type/contract, `BAC2310/2311` engine-coupled identifier resolution,
  `BAC2330` enum-literal value).
- Completion-server NDJSON protocol:
  - request `{"id":"<str>","op":"complete-type","className":"…"}`
  - response `{"id","ok":true,"result":{"resolvedClassName","functions":[…],"properties":[…]}}`
  - error `{"id","ok":false,"error":"…"}`
- Endpoint discovery file at `<ProjectDir>/Saved/BacEditorEndpoint.json`.

[Unreleased]: https://github.com/A7E7/vscode-bac/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/A7E7/vscode-bac/releases/tag/v0.4.0
