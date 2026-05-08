// 1:1 port of BacLexer.cpp.
//
// Notes on TS semantics vs the C++ source:
//   - We index the source by code units (UTF-16 in JS strings, same as TCHAR
//     in UE on the engine surface). Unicode beyond the BMP works because
//     identifiers / strings only inspect ASCII ranges anyway.
//   - Newlines become a single Newline token at depth 0, just like the C++
//     lexer; runs are collapsed.
//   - We preserve the exact diagnostic codes (BACL0001 … BACL0005) so cross-
//     impl parity tests can match by code.

import { BacDiagnostics, BacSourceLocation } from './diagnostics';
import { BacToken, BacTokenKind, lookupKeyword } from './token';

export function tokenize(source: string, diagnostics: BacDiagnostics): BacToken[] {
  return new Lexer(source, diagnostics).run();
}

class Lexer {
  private cursor = 0;
  private line   = 1;
  private column = 1;
  private bracketDepth = 0;
  private readonly tokens: BacToken[] = [];

  constructor(private readonly source: string, private readonly diags: BacDiagnostics) {}

  run(): BacToken[] {
    while (!this.isAtEnd()) {
      this.lexNext();
    }
    this.emit(BacTokenKind.Eof, this.cursor, this.cursor, this.location());
    return this.tokens;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  private isAtEnd(): boolean { return this.cursor >= this.source.length; }
  private peek(offset = 0): string {
    const i = this.cursor + offset;
    return i < this.source.length ? this.source[i] : '\0';
  }
  private location(): BacSourceLocation {
    return { line: this.line, column: this.column, offset: this.cursor };
  }
  private bump(): void { this.cursor++; this.column++; }
  private consumeLineBreak(): void {
    if (this.peek() === '\r') {
      this.cursor++;
      if (this.peek() === '\n') { this.cursor++; }
    } else {
      this.cursor++;
    }
    this.line++;
    this.column = 1;
  }
  private emit(kind: BacTokenKind, start: number, stopExclusive: number, location: BacSourceLocation): void {
    this.tokens.push({ kind, location, lexeme: this.source.slice(start, stopExclusive) });
  }

  // ─── Top-level dispatch ──────────────────────────────────────────────────
  private lexNext(): void {
    // Skip non-line whitespace.
    while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
      this.bump();
    }
    if (this.isAtEnd()) { return; }

    const tokenStart = this.cursor;
    const tokenLoc   = this.location();
    const ch         = this.peek();

    // Newlines.
    if (ch === '\r' || ch === '\n') {
      this.consumeLineBreak();
      if (this.bracketDepth === 0) {
        const last = this.tokens[this.tokens.length - 1];
        if (!last || last.kind !== BacTokenKind.Newline) {
          this.emit(BacTokenKind.Newline, tokenStart, this.cursor, tokenLoc);
        }
      }
      return;
    }

    // Comments.
    if (ch === '/' && this.peek(1) === '/') {
      while (!this.isAtEnd() && this.peek() !== '\r' && this.peek() !== '\n') {
        this.bump();
      }
      return;
    }
    if (ch === '/' && this.peek(1) === '*') {
      this.bump(); this.bump();
      while (!this.isAtEnd()) {
        if (this.peek() === '*' && this.peek(1) === '/') { this.bump(); this.bump(); return; }
        if (this.peek() === '\r' || this.peek() === '\n') { this.consumeLineBreak(); }
        else { this.bump(); }
      }
      this.diags.error('Unterminated block comment.', tokenLoc, 'BACL0004');
      return;
    }

    if (isAlpha(ch) || ch === '_') { return this.lexIdentifierOrKeyword(tokenStart, tokenLoc); }
    if (isDigit(ch))               { return this.lexNumber(tokenStart, tokenLoc); }
    if (ch === '"')                { return this.lexString(tokenStart, tokenLoc); }

    this.lexPunct(tokenStart, tokenLoc);
  }

  // ─── Identifiers / keywords ──────────────────────────────────────────────
  private lexIdentifierOrKeyword(tokenStart: number, tokenLoc: BacSourceLocation): void {
    while (!this.isAtEnd() && (isAlnum(this.peek()) || this.peek() === '_')) { this.bump(); }
    const lexeme = this.source.slice(tokenStart, this.cursor);
    const kind = lookupKeyword(lexeme);
    this.emit(kind, tokenStart, this.cursor, tokenLoc);
  }

  // ─── Numbers ─────────────────────────────────────────────────────────────
  private lexNumber(tokenStart: number, tokenLoc: BacSourceLocation): void {
    // Hex / binary prefixes.
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      this.bump(); this.bump();
      const digitStart = this.cursor;
      while (!this.isAtEnd() && isHexDigit(this.peek())) { this.bump(); }
      if (this.cursor === digitStart) {
        this.diags.error("Hex literal '0x' has no digits.", tokenLoc, 'BACL0005');
      }
      this.emit(BacTokenKind.IntLit, tokenStart, this.cursor, tokenLoc);
      return;
    }
    if (this.peek() === '0' && (this.peek(1) === 'b' || this.peek(1) === 'B')) {
      this.bump(); this.bump();
      const digitStart = this.cursor;
      while (!this.isAtEnd() && (this.peek() === '0' || this.peek() === '1')) { this.bump(); }
      if (this.cursor === digitStart) {
        this.diags.error("Binary literal '0b' has no digits.", tokenLoc, 'BACL0005');
      }
      this.emit(BacTokenKind.IntLit, tokenStart, this.cursor, tokenLoc);
      return;
    }

    while (!this.isAtEnd() && isDigit(this.peek())) { this.bump(); }

    let isFloat = false;
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      isFloat = true;
      this.bump();
      while (!this.isAtEnd() && isDigit(this.peek())) { this.bump(); }
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      isFloat = true;
      this.bump();
      if (this.peek() === '+' || this.peek() === '-') { this.bump(); }
      const digitStart = this.cursor;
      while (!this.isAtEnd() && isDigit(this.peek())) { this.bump(); }
      if (this.cursor === digitStart) {
        this.diags.error('Float exponent has no digits.', tokenLoc, 'BACL0005');
      }
    }
    this.emit(isFloat ? BacTokenKind.FloatLit : BacTokenKind.IntLit, tokenStart, this.cursor, tokenLoc);
  }

  // ─── String literals ─────────────────────────────────────────────────────
  private lexString(tokenStart: number, tokenLoc: BacSourceLocation): void {
    this.bump(); // opening quote
    let closed = false;
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === '"')                       { this.bump(); closed = true; break; }
      if (ch === '\r' || ch === '\n') {
        this.diags.error('Unterminated string literal (newline before closing quote).', tokenLoc, 'BACL0002');
        break;
      }
      if (ch === '\\') {
        const escLoc = this.location();
        this.bump();
        if (this.isAtEnd()) {
          this.diags.error('Unterminated escape sequence.', escLoc, 'BACL0003');
          break;
        }
        const esc = this.peek();
        if ('ntr\\"\'0'.includes(esc)) {
          this.bump();
        } else if (esc === 'u') {
          this.bump();
          let count = 0;
          while (count < 4 && !this.isAtEnd() && isHexDigit(this.peek())) { this.bump(); count++; }
          if (count !== 4) {
            this.diags.error('Invalid \\u escape: requires 4 hex digits.', escLoc, 'BACL0003');
          }
        } else {
          this.diags.error(`Unknown escape sequence '\\${esc}'.`, escLoc, 'BACL0003');
          this.bump();
        }
        continue;
      }
      this.bump();
    }
    if (!closed) {
      this.diags.error('Unterminated string literal.', tokenLoc, 'BACL0002');
    }
    this.emit(BacTokenKind.StringLit, tokenStart, this.cursor, tokenLoc);
  }

  // ─── Punctuation ─────────────────────────────────────────────────────────
  private lexPunct(tokenStart: number, tokenLoc: BacSourceLocation): void {
    const ch = this.peek();
    const n  = this.peek(1);

    const single = (k: BacTokenKind): void => {
      this.bump();
      this.emit(k, tokenStart, this.cursor, tokenLoc);
    };
    const pair = (k: BacTokenKind): void => {
      this.bump(); this.bump();
      this.emit(k, tokenStart, this.cursor, tokenLoc);
    };

    switch (ch) {
      case '{': return single(BacTokenKind.LBrace);
      case '}': return single(BacTokenKind.RBrace);
      case '(':
        this.bracketDepth++;
        return single(BacTokenKind.LParen);
      case ')':
        if (this.bracketDepth > 0) { this.bracketDepth--; }
        return single(BacTokenKind.RParen);
      case '[':
        this.bracketDepth++;
        return single(BacTokenKind.LBracket);
      case ']':
        if (this.bracketDepth > 0) { this.bracketDepth--; }
        return single(BacTokenKind.RBracket);
      case ',': return single(BacTokenKind.Comma);
      case ';': return single(BacTokenKind.Semicolon);
      case ':': return single(BacTokenKind.Colon);
      case '.': return single(BacTokenKind.Dot);
      case '@': return single(BacTokenKind.At);
      case '?': return single(BacTokenKind.Question);

      case '=':
        if (n === '=') { return pair(BacTokenKind.EqEq); }
        return single(BacTokenKind.Assign);
      case '!':
        if (n === '=') { return pair(BacTokenKind.NotEq); }
        return single(BacTokenKind.Bang);
      case '<':
        if (n === '=') { return pair(BacTokenKind.LtEq); }
        return single(BacTokenKind.Lt);
      case '>':
        if (n === '=') { return pair(BacTokenKind.GtEq); }
        return single(BacTokenKind.Gt);
      case '+':
        if (n === '=') { return pair(BacTokenKind.PlusEq); }
        return single(BacTokenKind.Plus);
      case '-':
        if (n === '=') { return pair(BacTokenKind.MinusEq); }
        return single(BacTokenKind.Minus);
      case '*':
        if (n === '=') { return pair(BacTokenKind.StarEq); }
        return single(BacTokenKind.Star);
      case '/':
        if (n === '=') { return pair(BacTokenKind.SlashEq); }
        return single(BacTokenKind.Slash);
      case '%':
        if (n === '=') { return pair(BacTokenKind.PercentEq); }
        return single(BacTokenKind.Percent);

      case '&':
        if (n === '&') { return pair(BacTokenKind.AmpAmp); }
        break;
      case '|':
        if (n === '|') { return pair(BacTokenKind.PipePipe); }
        break;
    }

    this.diags.error(
      `Unexpected character '${ch}' (U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}).`,
      tokenLoc, 'BACL0001');
    this.bump();
  }
}

// ─── Char predicates ───────────────────────────────────────────────────────
function isAlpha(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}
function isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
function isAlnum(ch: string): boolean { return isAlpha(ch) || isDigit(ch); }
function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
