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
