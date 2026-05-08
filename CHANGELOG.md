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
