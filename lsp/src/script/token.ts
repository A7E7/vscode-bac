// 1:1 port of EBacTokenKind / FBacToken from
//   Plugins/BlueprintAsCode/Source/BlueprintAsCodeCore/Public/Script/BacToken.h
// Order is wire-stable; do not reorder existing entries — append new ones at
// the bottom of their group so diagnostic codes referencing token kinds stay
// consistent across the C++ and TS lexers.

import { BacSourceLocation } from './diagnostics';

export enum BacTokenKind {
  Invalid = 0,
  Eof,
  Newline,        // emitted only when bracket-nesting depth is 0

  // Literals
  IntLit,
  FloatLit,
  StringLit,

  // Identifier
  Identifier,

  // Keywords — declaration
  Kw_Class,
  Kw_Interface,
  Kw_Implements,
  Kw_Import,
  Kw_From,
  Kw_Var,
  Kw_Let,
  Kw_Function,
  Kw_Pure,
  Kw_Event,
  Kw_Component,
  Kw_Attach,
  Kw_Construction,
  Kw_Widget,
  Kw_Macro,
  Kw_Collapsed,
  Kw_Inputs,
  Kw_Outputs,
  Kw_Defaults,
  Kw_Settings,
  Kw_Struct,
  Kw_Table,
  Kw_Row,
  Kw_Timeline,
  Kw_Track,

  // Keywords — control flow
  Kw_If,
  Kw_Else,
  Kw_For,
  Kw_While,
  Kw_In,
  Kw_Break,
  Kw_Continue,
  Kw_Return,
  Kw_Await,
  Kw_Reset,

  // Keywords — expression
  Kw_Super,
  Kw_As,
  Kw_None,
  Kw_True,
  Kw_False,
  Kw_Default,
  Kw_Asset,
  Kw_This,
  Kw_New,

  // Keywords — parameter modifiers
  Kw_Ref,
  Kw_Const,
  Kw_Out,

  // Punctuation
  LBrace,
  RBrace,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Semicolon,
  Colon,
  Dot,
  At,
  Question,

  // Assignment
  Assign,
  FatArrow,        // =>  (UMG widget property binding)
  PlusEq,
  MinusEq,
  StarEq,
  SlashEq,
  PercentEq,

  // Comparison
  EqEq,
  NotEq,
  Lt,
  Gt,
  LtEq,
  GtEq,

  // Arithmetic
  Plus,
  Minus,
  Star,
  Slash,
  Percent,

  // Logical
  AmpAmp,
  PipePipe,
  Bang,
}

export interface BacToken {
  kind:     BacTokenKind;
  location: BacSourceLocation;
  lexeme:   string;
}

const KW_NAMES: Record<string, BacTokenKind> = {
  class:        BacTokenKind.Kw_Class,
  interface:    BacTokenKind.Kw_Interface,
  implements:   BacTokenKind.Kw_Implements,
  import:       BacTokenKind.Kw_Import,
  from:         BacTokenKind.Kw_From,
  var:          BacTokenKind.Kw_Var,
  let:          BacTokenKind.Kw_Let,
  function:     BacTokenKind.Kw_Function,
  pure:         BacTokenKind.Kw_Pure,
  event:        BacTokenKind.Kw_Event,
  component:    BacTokenKind.Kw_Component,
  attach:       BacTokenKind.Kw_Attach,
  construction: BacTokenKind.Kw_Construction,
  widget:       BacTokenKind.Kw_Widget,
  macro:        BacTokenKind.Kw_Macro,
  collapsed:    BacTokenKind.Kw_Collapsed,
  inputs:       BacTokenKind.Kw_Inputs,
  outputs:      BacTokenKind.Kw_Outputs,
  defaults:     BacTokenKind.Kw_Defaults,
  settings:     BacTokenKind.Kw_Settings,
  struct:       BacTokenKind.Kw_Struct,
  table:        BacTokenKind.Kw_Table,
  row:          BacTokenKind.Kw_Row,
  timeline:     BacTokenKind.Kw_Timeline,
  track:        BacTokenKind.Kw_Track,
  if:           BacTokenKind.Kw_If,
  else:         BacTokenKind.Kw_Else,
  for:          BacTokenKind.Kw_For,
  while:        BacTokenKind.Kw_While,
  in:           BacTokenKind.Kw_In,
  break:        BacTokenKind.Kw_Break,
  continue:     BacTokenKind.Kw_Continue,
  return:       BacTokenKind.Kw_Return,
  await:        BacTokenKind.Kw_Await,
  reset:        BacTokenKind.Kw_Reset,
  super:        BacTokenKind.Kw_Super,
  as:           BacTokenKind.Kw_As,
  none:         BacTokenKind.Kw_None,
  // BP's `FName::None` round-trips into the transcriber's emitted .bac
  // capitalised — accept both forms so transcribed scripts parse without
  // a separate case-fix step. Mirrors `BacLexer.cpp` (`BAC_KW("None", Kw_None)`).
  None:         BacTokenKind.Kw_None,
  true:         BacTokenKind.Kw_True,
  false:        BacTokenKind.Kw_False,
  default:      BacTokenKind.Kw_Default,
  asset:        BacTokenKind.Kw_Asset,
  this:         BacTokenKind.Kw_This,
  new:          BacTokenKind.Kw_New,
  ref:          BacTokenKind.Kw_Ref,
  const:        BacTokenKind.Kw_Const,
  out:          BacTokenKind.Kw_Out,
};

export function lookupKeyword(lexeme: string): BacTokenKind {
  return KW_NAMES[lexeme] ?? BacTokenKind.Identifier;
}

const TOKEN_NAMES: Record<BacTokenKind, string> = (() => {
  const out: Partial<Record<BacTokenKind, string>> = {};
  // Iterate the enum and build a snake_case name for each numeric value.
  // Hand-written so the diagnostic strings exactly match the C++ side.
  out[BacTokenKind.Invalid]    = 'invalid';
  out[BacTokenKind.Eof]        = 'eof';
  out[BacTokenKind.Newline]    = 'newline';
  out[BacTokenKind.IntLit]     = 'int_lit';
  out[BacTokenKind.FloatLit]   = 'float_lit';
  out[BacTokenKind.StringLit]  = 'string_lit';
  out[BacTokenKind.Identifier] = 'identifier';
  for (const [name, kind] of Object.entries(KW_NAMES)) { out[kind] = `kw_${name}`; }
  out[BacTokenKind.LBrace]     = 'lbrace';
  out[BacTokenKind.RBrace]     = 'rbrace';
  out[BacTokenKind.LParen]     = 'lparen';
  out[BacTokenKind.RParen]     = 'rparen';
  out[BacTokenKind.LBracket]   = 'lbracket';
  out[BacTokenKind.RBracket]   = 'rbracket';
  out[BacTokenKind.Comma]      = 'comma';
  out[BacTokenKind.Semicolon]  = 'semicolon';
  out[BacTokenKind.Colon]      = 'colon';
  out[BacTokenKind.Dot]        = 'dot';
  out[BacTokenKind.At]         = 'at';
  out[BacTokenKind.Question]   = 'question';
  out[BacTokenKind.Assign]     = 'assign';
  out[BacTokenKind.FatArrow]   = 'fat_arrow';
  out[BacTokenKind.PlusEq]     = 'plus_eq';
  out[BacTokenKind.MinusEq]    = 'minus_eq';
  out[BacTokenKind.StarEq]     = 'star_eq';
  out[BacTokenKind.SlashEq]    = 'slash_eq';
  out[BacTokenKind.PercentEq]  = 'percent_eq';
  out[BacTokenKind.EqEq]       = 'eq_eq';
  out[BacTokenKind.NotEq]      = 'not_eq';
  out[BacTokenKind.Lt]         = 'lt';
  out[BacTokenKind.Gt]         = 'gt';
  out[BacTokenKind.LtEq]       = 'lt_eq';
  out[BacTokenKind.GtEq]       = 'gt_eq';
  out[BacTokenKind.Plus]       = 'plus';
  out[BacTokenKind.Minus]      = 'minus';
  out[BacTokenKind.Star]       = 'star';
  out[BacTokenKind.Slash]      = 'slash';
  out[BacTokenKind.Percent]    = 'percent';
  out[BacTokenKind.AmpAmp]     = 'amp_amp';
  out[BacTokenKind.PipePipe]   = 'pipe_pipe';
  out[BacTokenKind.Bang]       = 'bang';
  return out as Record<BacTokenKind, string>;
})();

export function tokenKindName(kind: BacTokenKind): string {
  return TOKEN_NAMES[kind] ?? '?';
}
