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
└── editors/code/                    # VS Code extension
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

To install the extension locally:

```bash
cd editors/code
# Open this folder in VS Code, then F5 to launch the extension dev host
```

To package as a VSIX:

```bash
cd editors/code
npx --package=@vscode/vsce vsce package
code --install-extension vscode-bac-0.1.0.vsix
```

## Status

- ✅ Tree-sitter grammar — parses 68/68 fixtures from the BlueprintAsCode plugin's `Tests/Corpus/` and `Examples/`
- ✅ Highlight queries (`queries/highlights.scm`) — covers all node kinds
- ✅ TextMate grammar (`syntaxes/bac.tmLanguage.json`) — VS Code highlighting
- ✅ Language configuration — comments, brackets, auto-indent, surround pairs
- ✅ Snippets — class/function/event/component/if-let/foreach/await/RepNotify
- ⏳ LSP server (planned) — diagnostics from the existing C++ validator via a `BacLint` UE commandlet, plus a TypeScript LSP wrapper

## License

MIT
