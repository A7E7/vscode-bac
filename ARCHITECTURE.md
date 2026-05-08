# Architecture — vscode-bac

This document describes how the **vscode-bac** repo is structured, where each
feature lives, and the boundaries between this repo and the closed-source
[BlueprintAsCode][plugin] UE plugin. Read it before adding a non-trivial
feature; update it whenever you change the boundaries it describes.

[plugin]: https://github.com/A7E7/BlueprintAsCode

## Components

```
vscode-bac/
├── grammar.js                # Tree-sitter grammar — single source of truth
├── queries/highlights.scm    # Tree-sitter highlight queries
├── src/                      # Generated parser (committed)
├── tree-sitter.json          # Bindings + grammar metadata
├── lsp/
│   ├── src/
│   │   ├── server.ts         # LSP server entry + CLI modes
│   │   ├── script/           # Lex / parse / AST / diagnostics  (TS port of C++)
│   │   ├── validate/         # Contract / reference / type checks (TS port)
│   │   ├── completion/       # Completion provider + engine proxy
│   │   ├── format/           # Opinionated formatter (Prettier doc IR) + Prettier plugin export
│   │   └── navigation/       # Hover / goto-def / doc-symbols / refs / highlights / sigHelp / code-actions
│   └── package.json
├── editors/code/             # VS Code extension
│   ├── src/extension.ts      # Spawns the LSP over IPC
│   ├── server/               # Bundled LSP (populated by `bundle-lsp` script)
│   ├── package.json          # Extension manifest + settings schema
│   ├── language-configuration.json
│   ├── syntaxes/bac.tmLanguage.json
│   ├── snippets/bac.code-snippets
│   └── icons/
└── test/corpus/              # Tree-sitter test fixtures
```

The standalone Prettier plugin lives in a sibling repo
([prettier-plugin-bac](https://github.com/A7E7/prettier-plugin-bac)) — it
clones next to vscode-bac and rebuilds against `lsp/out/{script,format}/`.

## Data flow

### Diagnostics (two streams, merged)

```
.bac edit ──┬──▶ TS lex+parse+contract+reference+type  ──▶ astDiagnostics ──┐
            │   (50 ms debounce, runs on every change)                       │
            │                                                                ├─▶ publishDiagnostics
.bac save ──┴──▶ UnrealEditor-Cmd … bac.lint <in> <out>  ──▶ engineDiags ───┘   (deduped on
                 (one inflight per doc, ~5 s)                                    code|line|col)
```

Engine pass diagnostics override AST pass diagnostics on the same
`(code, line, column)` — same hit reported by both pipelines means the engine
already confirmed it; we don't double-publish.

### Completion (engine-augmented)

```
textDocument/completion ──▶ analyzeCursor (text-only) ──▶ "top-level" or "Mesh."
                          ──▶ findScopeAt (AST walk)
                          ──▶ buildCompletionItems (TS-only base)
                          ──▶ if member-access AND receiver type known
                              ──▶ BacEngineProxy.completeType(className)
                                  ──▶ NDJSON over TCP loopback to running editor
                                  ──▶ in-memory cache per className
                          ──▶ merge by label → CompletionItem[]
```

The proxy polls `<ProjectDir>/Saved/BacEditorEndpoint.json` every 1 s when
disconnected; reads `{port, pid, projectDir}` and connects. Editor closes →
socket dies → next poll reconnects when the file reappears.

### Navigation suite (TS-only, optional engine)

`hover`, `definition`, `documentSymbol`, `references`, `documentHighlight`,
`signatureHelp`, and `codeAction` all share
`lsp/src/navigation/text-utils.ts` for cursor-to-identifier resolution.
`hover` and `signatureHelp` additionally consult the engine proxy for
inherited UFUNCTIONs and UPROPERTYs — same lookup as completion, same
in-memory cache.

### Code actions

Diagnostics that ship with `fixes: string[]` get a `BacDiagnosticData`
payload attached to `Diagnostic.data` at publish time. The `codeAction`
handler reads it back, parses the ``replace `X` with `Y` `` patterns into
`TextEdit`s, and returns `CodeActionKind.QuickFix` actions. No re-running
of validators is needed — the data flows through the diagnostic itself.

### Formatter

```
.bac source ──▶ tokenize + parse           (lsp/src/script/, shared with diagnostics)
            ──▶ scanComments               (regex pre-scan, attaches comments to root)
            ──▶ printBacRoot               (lsp/src/format/print.ts — Doc IR)
            ──▶ printDocToString           (Prettier's line-fitting algorithm)
            ──▶ post-process               (collapse 3+ newlines, ensure trailing \n)
            ──▶ formatted text
```

The formatter lives in `lsp/src/format/`:

- `parser.ts` — wraps the existing tokenize+parse, scans comments separately
  (the lexer eats them) and attaches them to a `BacFormatRoot` wrapper.
- `print.ts` — pure function `(BacFormatRoot) → Doc`. One print method per
  AST node kind. Style decisions are inline; no config knobs.
- `format.ts` — public `formatBacText()` API plus `bacPrettierPlugin`
  object. The plugin sidesteps Prettier's path / comment machinery by
  running the entire format inside `parse()` and returning the cached doc
  to Prettier's printer.
- The same code is re-exported by the standalone
  [`prettier-plugin-bac`](https://github.com/A7E7/prettier-plugin-bac)
  package (sibling repo) so external tooling can use it without depending
  on the LSP.

## Boundaries

This repo owns:
- Grammar, highlights, snippets, language config
- TS port of validator passes (BAC1xxx, BAC22xx, BAC23xx without engine reflection)
- LSP server, CLI modes, completion+navigation providers

The closed-source plugin owns:
- Engine-coupled validator passes (`BacIdentifierCheck` — BAC2310/2311 from
  parent UClass + UFUNCTION reflection)
- Generator (BP → BAC) and transcriber (BAC → BP)
- The `bac.lint` exec command (writes JSON to a file path)
- The completion server (`BacCompletionServer`, NDJSON over TCP)

Cross-repo wire contracts:

| Contract                                | Defined in     | Consumed in     |
|-----------------------------------------|----------------|-----------------|
| `bac.lint` JSON output shape            | plugin         | `lsp/src/server.ts` (`BacDiagnostic_LintWire`) |
| Diagnostic codes (`BAC*`)               | plugin         | TS validator passes (must match) |
| Completion server NDJSON protocol       | plugin         | `lsp/src/completion/engine-proxy.ts` |
| `BacEditorEndpoint.json` discovery file | plugin         | `lsp/src/completion/engine-proxy.ts` |
| `.bac` syntax                           | grammar.js + plugin parser | both |

A change to any of these requires a coordinated update in both repos. See
[CLAUDE.md](CLAUDE.md) for the protocol.

## Key design choices

**TS validator port.** We hand-port the C++ lexer/parser/AST and
contract/reference/type passes to TypeScript so they run at keystroke time
without spawning UE. Tree-sitter would also work for parsing but the runtime
binding is fragile across Node versions, and we want errors / locations to
match the C++ side byte-for-byte. The port is 1:1 — same names, same control
flow — so divergences are easy to spot.

**Diagnostic codes are wire-stable.** They're documented here and in the
plugin's `ARCHITECTURE.md`. AI agents pattern-match on them deterministically;
renumbering would silently break those agents. Add new codes; never reuse.

**Completion: running editor over local socket.** Spawning UE per request
costs ~5 s. Talking to the already-running editor over a TCP loopback socket
is sub-100 ms. Endpoint discovery via a file the plugin writes on startup
keeps the LSP loosely coupled — no env vars, no port pinning.

**Navigation lives in TS only.** `hover`/`definition`/`refs`/etc. work
entirely off the parsed AST and the document text — they keep working when
no UE editor is open. Hover is the only one that opportunistically consults
the engine for inherited members.

## Build & test

```bash
# Grammar / parser
npm install
npm run build      # tree-sitter generate
npm test           # tree-sitter test (against test/corpus/*.txt)

# Language server
cd lsp && npm install && npm run build && cd ..

# VS Code extension (bundles the LSP into the VSIX)
cd editors/code
npm install
npm run compile && npm run bundle-lsp
npx --package=@vscode/vsce vsce package --skip-license
"$(which code-insiders || which code)" --install-extension vscode-bac-0.4.0.vsix --force
```

Smoke tests for non-trivial features should go under `lsp/src/**` next to the
module they test, runnable via `node -e "…"` against fixtures in the plugin
repo's `Examples/` and `Tests/Corpus/` directories.

### Validator parity test

`lsp/src/validate/parity-test.ts` is the TS-side enforcer of the
validator wire-stable contract. It loads
`Tests/Corpus/parity_manifest.json` from the BlueprintAsCode plugin
repo, runs every `AstOnly` fixture through the TS validator, and
asserts the diagnostic-code counts match the manifest exactly. Run via
`npm run parity` (rebuilds first).

The plugin root is resolved in this order: argv[2], `$BAC_PLUGIN_ROOT`,
sibling-repo default (`../BACSample/Plugins/BlueprintAsCode`).
`AstOnly+Identifiers` entries are skipped — the identifier-resolution
pass needs UE reflection that only the C++ pipeline has. The C++ side
asserts the full manifest via the `BAC.Validate.ParityManifest`
automation test in the plugin.

When adding a new shared fixture: drop the `.bac` in the plugin repo's
`Tests/Corpus/`, add a manifest entry on that side, run `npm run parity`
here. Any drift between the two ports breaks one or both tests
immediately.
