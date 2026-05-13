# Claude instructions — vscode-bac

This file is loaded as system context for any Claude session in this repo.
Keep it tight; don't repeat what's documented in [ARCHITECTURE.md](ARCHITECTURE.md)
or [CHANGELOG.md](CHANGELOG.md). Cross-link instead.

## Shared-state map (where this repo touches the others)

Three sibling repos (`vscode-bac`, `prettier-plugin-bac`,
[`BlueprintAsCode` plugin](https://github.com/A7E7/BlueprintAsCode)) — every
edit in this list needs a coordinated change in the other side(s). The
detailed update protocol below references these touchpoints; this map is
the cheat-sheet at a glance.

| Touched here                                  | Also moves                                                                 |
|-----------------------------------------------|----------------------------------------------------------------------------|
| `lsp/src/script/**` or `lsp/src/format/**`    | `prettier-plugin-bac` — rerun `scripts/build.js` so the published `dist/` doesn't drift |
| Diagnostic codes (`BAC*`)                     | both this `CHANGELOG.md` *Wire-stable contracts* AND the plugin's `CHANGELOG.md` + `ARCHITECTURE.md` codes table |
| Completion-server NDJSON shape (request/response/push) | both repos' CHANGELOGs; LSP client (`lsp/src/completion/engine-proxy.ts`); plugin server (`BacCompletionServer.cpp`) |
| `bac.lint` / `bac.sync*` JSON output          | both repos' CHANGELOGs; LSP wrapper (`server.ts`); plugin command (`BacConsoleCommands.cpp` / `BacSyncCommand.cpp`) |
| `<Asset>.bac.sync.json` schema                | both repos' CHANGELOGs; plugin reader/writer (`BacSyncMetadata.cpp`)       |
| Sidecar file extensions (`FBacDocument::*Extension()`) | both repos; LSP path utilities; plugin `BacPathMap.cpp`                    |
| Add / rename a `bac.*` LSP setting            | `editors/code/package.json` `contributes.configuration` schema             |
| Add / rename a tree-sitter node kind          | `queries/highlights.scm` + `editors/code/syntaxes/bac.tmLanguage.json` (or its TextMate analogue) |

## Documentation update protocol

When you change code, update docs in the **same change**:

| Change                                  | Update                                              |
|-----------------------------------------|-----------------------------------------------------|
| Ship a user-visible feature             | `CHANGELOG.md` `[Unreleased]` section + `README.md` *Status*  |
| Add or change a wire-stable contract    | `CHANGELOG.md` `### Wire-stable contracts` + plugin docs (the contract is shared) |
| Touch the LSP capability set            | `ARCHITECTURE.md` *Data flow* + `README.md` *Status*           |
| Add a new module under `lsp/src/`       | `ARCHITECTURE.md` *Components* tree                            |
| Cross the line between this repo and the plugin | `ARCHITECTURE.md` *Boundaries* table + a parallel commit/issue in the plugin repo |
| Change formatter output (anything that affects formatted-file content) | `CHANGELOG.md` *Wire-stable contracts* — the canonical style is wire-stable; bump major if the change isn't backwards-compatible |
| Change anything under `lsp/src/script/**` or `lsp/src/format/**` (lexer, parser, AST, diagnostics, formatter) | rebuild the sibling `prettier-plugin-bac` repo (`cd ../prettier-plugin-bac && node scripts/build.js`) — its `dist/` bundles BOTH `script/` and `format/` so any change to either drifts the npm package |
| Add / rename a `bac.*` LSP setting       | extend `editors/code/package.json` `contributes.configuration` schema so VS Code shows the setting under Settings → Extensions → Blueprint as Code |
| Bump the extension version              | `editors/code/package.json` + `CHANGELOG.md` (move `[Unreleased]` to a new version section, update compare links at the bottom) |

`README.md` should stay terse — it's the marketing surface. Deep docs go in
`ARCHITECTURE.md`. History goes in `CHANGELOG.md`. Never duplicate.

## Commit / push protocol

- **Auto-commit** after every shippable change (build clean + smoke-tested
  + docs updated per the table above). One slice = one commit. Use a
  deliberate message — readers should understand the WHY without diffing.
  Stage with `git add -A` (the `.gitignore` already excludes generated
  output and node_modules).
- **Auto-push** to `main` after committing. This repo is public, solo dev,
  no review gate; pushing makes work visible on GitHub for review.
- **Don't bump the extension version or publish to a marketplace
  autonomously.** Marketplace publishes are explicit user actions.
- **Never append a `Co-Authored-By: Claude …` trailer.** The user is the
  sole author of record on this repo.

## Wire-stable contracts (do not break casually)

These are consumed by AI agents, CI pipelines, and the plugin. Changes must
ship in both this repo and the plugin atomically:

- Diagnostic JSON shape from `--once` and `--once-no-engine`
- Diagnostic codes (`BAC1xxx`, `BAC22xx`, `BAC23xx`, `BAC2310/2311`, `BAC2330`)
- Completion server NDJSON protocol (`{op, ...}` request, `{ok, result|error}` response)
- Endpoint discovery file path (`<ProjectDir>/Saved/BacEditorEndpoint.json`) and shape

If you renumber a diagnostic code without adding it to the list, you've
broken downstream agents silently. Add new codes; never reuse old ones.

## Repo conventions

- **TS validator passes are 1:1 ports of C++.** Match C++ naming, control flow,
  and diagnostic locations. Divergence makes the parity sniff-test (`parity-smoke.ts`)
  fail loudly, which is the point.
- **No comments unless non-obvious.** Existing code follows this — keep it up.
  Docstrings live in `ARCHITECTURE.md`, not on every function.
- **Discriminated unions on `kind`** for AST/expr/stmt/member, mirroring the
  C++ `EBac{Expr,Stmt,Member}Kind` enums.
- **Rebuild + reinstall workflow** (used for every dev iteration):
  ```bash
  cd lsp && npm run build && cd ../editors/code &&
    npm run compile && npm run bundle-lsp &&
    npx --package=@vscode/vsce vsce package --skip-license &&
    "$(which code-insiders || which code)" \
      --install-extension vscode-bac-0.4.0.vsix --force
  ```
- **`.vscodeignore`** must NOT exclude `node_modules/**` — the runtime
  `vscode-languageclient` dep needs to ship inside the VSIX. `vsce` strips
  devDependencies automatically.

## When stuck

- Parser errors on incomplete edits: parse anyway, work with the partial AST.
  See `lsp/src/completion/complete.ts` for the pattern (text-only cursor
  context analysis + best-effort AST walk).
- Member end-locations are not tracked on AST nodes. The "next member's start
  bounds the current member's range" heuristic is used by every navigation
  provider; reuse it instead of inventing new ones.
- Engine-coupled features that need a running UE editor: never block a
  user-facing path on it. The proxy (`BacEngineProxy`) returns `undefined`
  when no editor is reachable; consumers must degrade gracefully.

## Out of scope for this repo

Filing bugs about generator/transcriber behaviour, BP roundtrip fidelity, or
diagnostic text content goes to the plugin repo (closed source). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the routing table.
