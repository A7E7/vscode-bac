// Helpers shared across the navigation providers (hover / goto-def / find-refs).
// Operate on the raw document text and offsets — independent of the parser so
// they keep working when the document is mid-edit and the AST is broken.

export interface IdentRange {
  name:  string;
  start: number;   // inclusive
  end:   number;   // exclusive
}

export interface QualifiedIdent extends IdentRange {
  /** When the identifier sits to the right of a `.`, this is the bare-identifier on the left (e.g. `Mesh`). */
  receiver?: string;
}

/**
 * If `offset` lies inside an identifier, returns its bounds + name. Returns
 * undefined when the cursor is on whitespace, punctuation, or inside a string
 * literal. Identifier rule: `[A-Za-z_][A-Za-z0-9_]*` — same as the lexer.
 */
export function findIdentifierAt(text: string, offset: number): IdentRange | undefined {
  if (offset < 0 || offset > text.length) { return undefined; }

  // Walk left from cursor through identifier chars to find the start.
  let start = offset;
  while (start > 0 && isIdentChar(text.charCodeAt(start - 1))) { start--; }
  // Walk right from cursor (or from the offset itself if it's the very first
  // char of an identifier) to find the end.
  let end = offset;
  while (end < text.length && isIdentChar(text.charCodeAt(end))) { end++; }
  if (start === end) { return undefined; }
  // First char must be a letter or underscore (no leading-digit identifiers).
  const first = text.charCodeAt(start);
  if (!isIdentStart(first)) { return undefined; }
  return { name: text.slice(start, end), start, end };
}

/**
 * Like `findIdentifierAt` but also captures the receiver when the identifier
 * is the right-hand side of a `<receiver>.<name>` member access.
 */
export function findQualifiedIdentAt(text: string, offset: number): QualifiedIdent | undefined {
  const ident = findIdentifierAt(text, offset);
  if (!ident) { return undefined; }
  // Skip whitespace before the identifier; if the next char is a `.`, look
  // backwards for the receiver.
  let i = ident.start;
  while (i > 0 && isWs(text.charCodeAt(i - 1))) { i--; }
  if (i > 0 && text.charCodeAt(i - 1) === DOT) {
    i--;
    while (i > 0 && isWs(text.charCodeAt(i - 1))) { i--; }
    const recvEnd = i;
    while (i > 0 && isIdentChar(text.charCodeAt(i - 1))) { i--; }
    const receiver = text.slice(i, recvEnd);
    if (receiver.length > 0) { return { ...ident, receiver }; }
  }
  return ident;
}

const DOT = 0x2E;
function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D;
}
function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F;
}
function isIdentChar(c: number): boolean {
  return isIdentStart(c) || (c >= 0x30 && c <= 0x39);
}

// ─── Range helpers (1-based source location → 0-based LSP Position) ────────

export interface SimpleRange {
  startLine:   number;     // 0-based
  startColumn: number;     // 0-based
  endLine:     number;     // 0-based
  endColumn:   number;     // 0-based
}

/** Convert a (start offset, end offset) span back to a SimpleRange given the doc text. */
export function rangeFromSpan(text: string, startOffset: number, endOffset: number): SimpleRange {
  const start = positionAt(text, startOffset);
  const end   = positionAt(text, endOffset);
  return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}

interface ZeroPos { line: number; column: number }
function positionAt(text: string, offset: number): ZeroPos {
  // Linear scan — fine for source files; we'd index if files got huge.
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0A) { line++; col = 0; } else { col++; }
  }
  return { line, column: col };
}
