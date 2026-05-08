# vscode-bac

Tree-sitter grammar and VS Code extension for **BAC (Blueprint as Code)** — a
TypeScript-flavoured DSL that round-trips with Unreal Engine Blueprints. The
companion plugin lives at <https://github.com/A7E7/BlueprintAsCode>.

## Repo layout

```
.
├── grammar.js                       # Single source of truth for the grammar
├── queries/highlights.scm           # Tree-sitter highlight queries (Helix/Neovim/Zed)
├── src/                             # Generated parser (committed)
├── tree-sitter.json                 # Bindings + grammar metadata
├── lsp/                             # Language server (TypeScript)
│   ├── src/server.ts                # LSP mode + `--once <file>` CLI mode
│   ├── package.json
│   └── tsconfig.json
└── editors/code/                    # VS Code extension
    ├── src/extension.ts             # Spawns the LSP over stdio
    ├── package.json
    ├── language-configuration.json  # brackets, comments, indent rules
    ├── syntaxes/bac.tmLanguage.json # TextMate grammar (used by VS Code today)
    ├── snippets/bac.code-snippets
    └── icons/                       # File icons
```

The TextMate grammar in `editors/code/syntaxes/` is what VS Code actually uses
today for syntax highlighting. The tree-sitter grammar feeds Helix / Neovim /
Zed (and a future LSP server) — they share the same conceptual scopes so
changes stay in sync.

## Building

```bash
# Install tree-sitter CLI
npm install

# Generate the parser from grammar.js
npm run build

# Parse a file (smoke test)
npx tree-sitter parse path/to/file.bac
```

## VS Code extension

Build the LSP and the extension, then package + install:

```bash
# 1. Build the language server (TypeScript → JS)
cd lsp && npm install && npm run build && cd ..

# 2. Build + bundle + package the extension. The prepublish step copies the
#    LSP into editors/code/server/ so it ships inside the VSIX.
cd editors/code
npm install
npx --package=@vscode/vsce vsce package --skip-license
code --install-extension vscode-bac-0.2.0.vsix
```

Then open Settings → search "BAC" and set:

- **`bac.projectPath`** — absolute path to a `.uproject` that loads the
  BlueprintAsCode plugin (e.g. `/Users/you/UE/MyGame/MyGame.uproject`)
- **`bac.unrealEditorPath`** — absolute path to `UnrealEditor-Cmd` (default
  is the macOS UE 5.7 install location)

Open any `.bac` file and save it — diagnostics appear as squigglies.

## CLI mode (for AI agents / CI)

The same language server binary doubles as a one-shot linter:

```bash
BAC_PROJECT_PATH=/path/to/MyGame.uproject \
  node lsp/out/server.js --once script.bac
```

Prints `{ "ok": bool, "diagnostics": [...] }` to stdout, exits non-zero when
errors are present. Diagnostics are stable BAC codes (`BAC2310`,
`BAC2311`, …), so AI agents can pattern-match on them deterministically.

## Status

- ✅ Tree-sitter grammar — parses 68/68 fixtures from the BlueprintAsCode plugin's `Tests/Corpus/` and `Examples/`
- ✅ Highlight queries (`queries/highlights.scm`) — covers all node kinds
- ✅ TextMate grammar (`syntaxes/bac.tmLanguage.json`) — VS Code highlighting
- ✅ Language configuration — comments, brackets, auto-indent, surround pairs
- ✅ Snippets — class/function/event/component/if-let/foreach/await/RepNotify
- ✅ LSP server — wraps the BlueprintAsCode plugin's `bac.lint` UE exec command, surfaces diagnostics on save
- ✅ CLI mode — `node lsp/out/server.js --once <file.bac>` prints structured JSON for CI / AI agents

## License

MIT
