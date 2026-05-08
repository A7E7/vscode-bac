// Smoke test: lex+parse one .bac, run the contract check, print diagnostics.
import * as fs from 'node:fs';
import { tokenize } from '../script/lexer';
import { parse } from '../script/parser';
import { BacDiagnostics } from '../script/diagnostics';
import { runContractCheck } from './contract-check';

const path = process.argv[2];
if (!path) { console.error('usage: contract-smoke <file.bac>'); process.exit(2); }

const source = fs.readFileSync(path, 'utf8');
const diags  = new BacDiagnostics();
const tokens = tokenize(source, diags);
const ast    = parse(tokens, diags);
runContractCheck(ast, diags);

const errors   = diags.items.filter(d => d.severity === 'error');
const warnings = diags.items.filter(d => d.severity === 'warning');
console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
for (const d of diags.items) {
  console.log(`  ${d.severity} [${d.code}] ${d.location.line}:${d.location.column}  ${d.message}`);
  if (d.hint)  { console.log(`    hint: ${d.hint}`); }
  if (d.fixes) { for (const f of d.fixes) { console.log(`    fix:  ${f}`); } }
}
