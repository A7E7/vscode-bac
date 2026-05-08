# Contributing to vscode-bac

This repo holds the **language tooling**: grammar, highlights, snippets,
language config, and the LSP wrapper. The plugin that runs the actual BAC →
Blueprint round-trip is a separate, commercial product — see
[BlueprintAsCode][plugin].

What that means for contributions:

| Issue / PR target                         | Where it goes                                  |
| ----------------------------------------- | ---------------------------------------------- |
| Grammar bugs, missing syntax              | Here — `grammar.js` + `test/corpus/`           |
| Highlighting (TextMate or tree-sitter)    | Here — `syntaxes/` and `queries/highlights.scm`|
| Snippets, language configuration          | Here — `editors/code/`                         |
| LSP wrapper bugs                          | Here — `lsp/src/server.ts`                     |
| Diagnostic content (codes, messages)      | [BlueprintAsCode][plugin] (closed source)      |
| Generator / transcriber behaviour         | [BlueprintAsCode][plugin]                      |
| BP roundtrip fidelity                     | [BlueprintAsCode][plugin]                      |

[plugin]: https://github.com/A7E7/BlueprintAsCode

## Grammar changes

Every grammar change should:

1. Update `grammar.js`
2. Run `npm run build` and commit the regenerated `src/parser.c` etc.
3. Add or update a fixture under `test/corpus/` that pins the new shape
4. Run `npm test` and confirm all corpus tests still pass
5. Smoke-test against the BlueprintAsCode plugin's corpus (the
   `Tests/Corpus/*.bac` and `Examples/*.bac` files) — no parse errors expected

If your grammar change requires the upstream parser in BlueprintAsCode to
change too, please file a parallel issue there.

## License

By contributing, you agree your contribution is MIT-licensed (see `LICENSE`).
