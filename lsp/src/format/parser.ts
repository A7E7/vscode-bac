// Prettier parser adapter for `.bac`.
//
// Prettier expects `parse(text, options)` to return an AST root that its
// printer can walk. We wrap our existing tokenize + parse and tack on:
//   • A `Root` wrapper holding the script AST + the original source text.
//     The wrapper's existence makes Prettier's "root path" handling
//     deterministic (parsers normally produce a single root node).
//   • A `comments` array extracted by a regex pre-scan of the source. The
//     existing `tokenize()` skips comments, but Prettier wants them
//     attached so the printer can place them at the right positions.
//
// Comment attachment uses a simple proximity heuristic: a comment is
// "leading" to the next AST node whose `location.offset` is greater than the
// comment's end. The printer's `comments.ts` module pulls comments out of
// the bucket as it walks the tree.

import { tokenize } from '../script/lexer';
import { parse }    from '../script/parser';
import { BacDiagnostics } from '../script/diagnostics';
import * as ast from '../script/ast';

export interface BacComment {
  kind:  'line' | 'block';
  value: string;       // text without the `//` or `/* */` delimiters
  raw:   string;       // exactly as written, including delimiters
  start: number;       // byte offset, inclusive
  end:   number;       // byte offset, exclusive
}

export interface BacFormatRoot {
  type:     'BacRoot';      // Prettier looks at .type for tie-breaking
  ast:      ast.BacScriptAst;
  source:   string;
  comments: BacComment[];
}

export function parseBacForFormat(text: string): BacFormatRoot {
  const diags  = new BacDiagnostics();
  const tokens = tokenize(text, diags);
  const tree   = parse(tokens, diags);
  return { type: 'BacRoot', ast: tree, source: text, comments: scanComments(text) };
}

// Scan source for `// line` and `/* block */` comments. Doesn't try to be
// clever about strings — the lexer already validates that strings are
// well-formed, so by the time we run the formatter we can trust the source
// to round-trip. The one edge case we DO need is an in-string `//`: if our
// scan crosses an unmatched `"`, skip to the matching close.
function scanComments(text: string): BacComment[] {
  const out: BacComment[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // String literal — fast-forward past it.
    if (c === 0x22) {  // "
      i++;
      while (i < text.length) {
        const k = text.charCodeAt(i);
        if (k === 0x5C) { i += 2; continue; }   // \  → skip escape
        if (k === 0x22) { i++; break; }
        if (k === 0x0A) { break; }              // unterminated string — bail
        i++;
      }
      continue;
    }
    // Line comment.
    if (c === 0x2F && text.charCodeAt(i + 1) === 0x2F) {  // //
      const start = i;
      let j = i + 2;
      while (j < text.length && text.charCodeAt(j) !== 0x0A) { j++; }
      out.push({
        kind:  'line',
        value: text.slice(i + 2, j),
        raw:   text.slice(start, j),
        start, end: j,
      });
      i = j;
      continue;
    }
    // Block comment.
    if (c === 0x2F && text.charCodeAt(i + 1) === 0x2A) {  // /*
      const start = i;
      let j = i + 2;
      while (j < text.length - 1) {
        if (text.charCodeAt(j) === 0x2A && text.charCodeAt(j + 1) === 0x2F) {
          j += 2;
          break;
        }
        j++;
      }
      out.push({
        kind:  'block',
        value: text.slice(i + 2, j - 2),
        raw:   text.slice(start, j),
        start, end: j,
      });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}
