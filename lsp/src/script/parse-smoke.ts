// Walks a directory of .bac files, runs the TS lexer + parser, reports
// per-file pass/fail. Mirrors what we do with `tree-sitter parse` against
// the BlueprintAsCode corpus.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tokenize } from './lexer';
import { parse } from './parser';
import { BacDiagnostics } from './diagnostics';

function check(file: string): { ok: boolean; diags: number; firstError?: string } {
  const source = fs.readFileSync(file, 'utf8');
  const diags  = new BacDiagnostics();
  const tokens = tokenize(source, diags);
  parse(tokens, diags);
  const errors = diags.items.filter(d => d.severity === 'error');
  return {
    ok: errors.length === 0,
    diags: diags.items.length,
    firstError: errors[0]
      ? `[${errors[0].code}] ${errors[0].location.line}:${errors[0].location.column} ${errors[0].message}`
      : undefined,
  };
}

const root = process.argv[2];
if (!root) { console.error('usage: parse-smoke <dir>'); process.exit(2); }

const files: string[] = [];
function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) { walk(full); }
    else if (full.endsWith('.bac')) { files.push(full); }
  }
}
walk(root);

let pass = 0, fail = 0;
const failures: string[] = [];
for (const f of files) {
  const r = check(f);
  if (r.ok) { pass++; }
  else { fail++; failures.push(`${path.basename(f)} — ${r.firstError ?? '?'}`); }
}
console.log(`${pass} / ${files.length} parse OK`);
if (fail) {
  console.log('--- failures ---');
  for (const x of failures.slice(0, 25)) { console.log('  ' + x); }
  if (failures.length > 25) { console.log(`  … +${failures.length - 25} more`); }
}
