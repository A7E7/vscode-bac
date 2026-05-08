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

## Validator parity corpus (vendored at `test/parity-corpus/`)

The TS validator and the BlueprintAsCode plugin's C++ validator share a
contract: both must emit the same diagnostic codes (and counts) for every
`Validate_*.bac` fixture. The contract is pinned in the plugin's
`Tests/Corpus/parity_manifest.json`.

For CI, `test/parity-corpus/` is a vendored copy of the plugin's corpus —
the public CI can't reach the private plugin repo, so the snapshot lives
here. The parity test (`lsp/src/validate/parity-test.ts`) reads it
automatically when `BAC_PLUGIN_ROOT` isn't set.

When the plugin updates its manifest or fixtures, copy the updated files
over:

```sh
PLUGIN=~/UnrealProjects/BACSample/Plugins/BlueprintAsCode
DST=~/UnrealProjects/vscode-bac/test/parity-corpus

cp "$PLUGIN/Tests/Corpus/parity_manifest"*.json    "$DST/Tests/Corpus/"
cp "$PLUGIN/Tests/Corpus/Validate_"*.bac           "$DST/Tests/Corpus/"
cp "$PLUGIN/Examples/HealthPickup.bac"             "$DST/Examples/"
```

If you forget, CI catches it: the parity test fails when the vendored
manifest disagrees with the TS validator's behaviour.

## License

By contributing, you agree your contribution is MIT-licensed (see `LICENSE`).
