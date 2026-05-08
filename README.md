# vscode-bac

Editor tooling for **BAC (Blueprint as Code)** — a TypeScript-flavoured DSL
that round-trips with Unreal Engine Blueprints.

This repository ships:

- A **tree-sitter grammar** (the canonical definition of the BAC syntax, used
  by Helix / Neovim / Zed and by the language server below)
- A **VS Code extension** with TextMate highlighting, snippets, and language
  configuration
- A **language server** that exposes diagnostics over LSP — and as a CLI for
  CI / AI agents

## What works without the plugin

The grammar and editor surface are fully usable on their own:

- Syntax highlighting in VS Code (and any editor that consumes TextMate or
  tree-sitter grammars)
- Snippets, brackets, auto-indent, comment toggling
- A reusable grammar artifact for tooling, AI prompts, code review

These pieces are MIT-licensed and live in this public repo.

## What requires the plugin

For diagnostics — the actual semantic validation that catches typos in
identifiers, unresolved calls, contract violations, etc. — the language server
spawns the **[BlueprintAsCode UE plugin][plugin]**'s `bac.lint` exec command.
The plugin is sold separately on the Unreal Marketplace; without it, the
extension is highlighting-only.

> **Diagnostics need a UE project.** The language server requires:
>
> 1. The BlueprintAsCode plugin installed and enabled in a UE project
> 2. `UnrealEditor-Cmd` available locally
> 3. Both paths configured via VS Code settings (`bac.projectPath`,
>    `bac.unrealEditorPath`)
>
> Without these, the extension still highlights but produces no squigglies.

The plugin is the source of truth for round-tripping; the language server is a
thin glue layer that pipes the validator's output into the editor.

[plugin]: https://github.com/A7E7/BlueprintAsCode

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

## Building from source

```bash
# Grammar / parser
npm install
npm run build       # tree-sitter generate
npm test            # tree-sitter test (against test/corpus/*.txt)

# Language server
cd lsp && npm install && npm run build && cd ..

# VS Code extension (compiles + bundles the LSP into the VSIX)
cd editors/code
npm install
npx --package=@vscode/vsce vsce package --skip-license
code --install-extension vscode-bac-0.2.0.vsix
```

Then in VS Code: open Settings → search "BAC" and set:

- **`bac.projectPath`** — absolute path to a `.uproject` that loads the
  BlueprintAsCode plugin
- **`bac.unrealEditorPath`** — absolute path to `UnrealEditor-Cmd`
  (the macOS UE 5.7 default is pre-filled)

## CLI mode (for CI / AI agents)

The same language-server binary doubles as a one-shot linter:

```bash
BAC_PROJECT_PATH=/path/to/MyGame.uproject \
  node lsp/out/server.js --once script.bac
```

Prints `{ "ok": bool, "diagnostics": [...] }` to stdout and exits non-zero on
errors. Diagnostic codes (`BAC2310`, `BAC2311`, …) are stable, so AI agents
can pattern-match on them deterministically rather than parsing free-form
text.

## Status

- ✅ Tree-sitter grammar — parses 68 / 68 BlueprintAsCode corpus fixtures + the `HealthPickup.bac` example
- ✅ Highlight queries (`queries/highlights.scm`) — covers every node kind
- ✅ TextMate grammar (`syntaxes/bac.tmLanguage.json`) — VS Code highlighting
- ✅ Language configuration — comments, brackets, auto-indent, surround pairs
- ✅ Snippets — class / function / event / component / if-let / for-each / await / RepNotify
- ✅ LSP server — wraps the plugin's `bac.lint` UE exec command, surfaces diagnostics on save
- ✅ CLI mode — `node lsp/out/server.js --once <file.bac>` prints structured JSON for CI / AI agents
- ⏳ TypeScript port of AST-only validator passes — keystroke-time diagnostics for things that don't need UE reflection (declared-name conflicts, contract checks). The engine-coupled passes (parent-class identifier resolution, BP compile) stay in the plugin.

## Contributing

Grammar and highlight tweaks are welcome — please open issues / PRs against
`grammar.js`, the highlight query, or the TextMate grammar. The corpus tests
under `test/corpus/` should grow with any structural change.

For diagnostics or generator/transcriber behaviour, please file issues against
the [BlueprintAsCode][plugin] plugin instead — that's where the validator
lives and where the round-trip semantics get decided.

## License

MIT (this repository). The BlueprintAsCode UE plugin is licensed separately
under the Unreal Marketplace EULA.
