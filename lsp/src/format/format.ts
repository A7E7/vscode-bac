// Public format() API — used by the LSP's formatProvider, the CLI's
// `--format` mode, and (via re-export) the standalone `prettier-plugin-bac`
// npm package.
//
// We don't go through `prettier.format(text, { parser, plugins })` from
// within the LSP because that would re-tokenize the document twice (once
// for diagnostics, once here). Instead we own the pipeline:
//   tokenize → parse → printBacRoot (Doc) → printDocToString.
// For external use through Prettier's CLI we expose `bacPrettierPlugin`.

import { doc as PrettierDoc } from 'prettier';
import { parseBacForFormat, BacFormatRoot } from './parser';
import { printBacRoot } from './print';

const { printer: docPrinter } = PrettierDoc;

export interface BacFormatOptions {
  /** Print width — default 80 chars. */
  printWidth?: number;
  /** Tab width — default 2 spaces. */
  tabWidth?:   number;
}

/**
 * Format a `.bac` source string into the canonical opinionated style.
 * Returns the formatted text. Synchronous — the underlying lex / parse /
 * doc-to-string pipeline doesn't need any I/O.
 */
export function formatBacText(source: string, options: BacFormatOptions = {}): string {
  const root = parseBacForFormat(source);
  return formatBacRoot(root, options);
}

/** Same as `formatBacText` but takes an already-parsed root. */
export function formatBacRoot(root: BacFormatRoot, options: BacFormatOptions = {}): string {
  const docTree = printBacRoot(root);
  const out = docPrinter.printDocToString(docTree, {
    printWidth: options.printWidth ?? 80,
    tabWidth:   options.tabWidth   ?? 2,
    useTabs:    false,
  });
  // Always end with a single trailing newline so diffs stay clean.
  let text = out.formatted;
  if (!text.endsWith('\n')) { text += '\n'; }
  // Collapse any stray runs of 3+ newlines that the printer might emit when
  // a comment sits between two `hardline`s.
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

// ─── Prettier plugin ────────────────────────────────────────────────────

/**
 * Prettier plugin object. Exported so the standalone npm package
 * (prettier-plugin-bac) can re-export it without duplicating logic.
 *
 *   import * as bac from 'prettier-plugin-bac';
 *   await prettier.format(src, { parser: 'bac', plugins: [bac] });
 *
 * Implementation note: rather than walk the AST through Prettier's path /
 * recursive-print machinery, we treat the parse result as opaque and run
 * the entire format inside the parser. The printer then just hands back
 * the cached doc tree. This sidesteps Prettier's built-in comment handling
 * (which expects a specific node shape we don't match) — our own
 * `CommentCursor` in `print.ts` does that placement instead.
 */
export const bacPrettierPlugin = {
  languages: [{
    name:              'BAC',
    parsers:           ['bac'],
    extensions:        ['.bac'],
    vscodeLanguageIds: ['bac'],
  }],
  parsers: {
    bac: {
      parse: (text: string): { type: 'bac-doc'; doc: PrettierDoc.builders.Doc } => {
        const root = parseBacForFormat(text);
        return { type: 'bac-doc', doc: printBacRoot(root) };
      },
      astFormat: 'bac-ast',
      // Locations are unused (we never recurse), but Prettier requires the
      // hooks to exist. Stub them.
      locStart: (): number => 0,
      locEnd:   (): number => 0,
    },
  },
  printers: {
    'bac-ast': {
      print: (path: { getValue: () => { doc: PrettierDoc.builders.Doc } }): PrettierDoc.builders.Doc => {
        return path.getValue().doc;
      },
    },
  },
};
