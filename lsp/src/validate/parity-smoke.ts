// Parity sniff-test: run every Validate_* fixture in the BlueprintAsCode plugin
// through the TS validator and report which diagnostic codes were emitted.
// The C++ side has automation tests that pin expected codes per fixture
// (see Source/BlueprintAsCodeTests/Private/Tests/BacValidatorTests.cpp); this
// script is a quick smoke that lets us eyeball whether the two impls agree.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tokenize } from '../script/lexer';
import { parse } from '../script/parser';
import { BacDiagnostics } from '../script/diagnostics';
import { runContractCheck } from './contract-check';
import { runReferenceCheck } from './reference-check';
import { runTypeCheck } from './type-check';

const root = process.argv[2];
if (!root) { console.error('usage: parity-smoke <Validate_*.bac dir>'); process.exit(2); }

const files = fs.readdirSync(root).filter(f => f.startsWith('Validate_') && f.endsWith('.bac')).sort();
let pad = 0; for (const f of files) { pad = Math.max(pad, f.length); }

for (const f of files) {
  const full = path.join(root, f);
  const source = fs.readFileSync(full, 'utf8');
  const diags  = new BacDiagnostics();
  const tokens = tokenize(source, diags);
  const ast    = parse(tokens, diags);
  runContractCheck(ast, diags);
  runReferenceCheck(ast, diags);
  runTypeCheck(ast, diags);
  const errs    = diags.items.filter(d => d.severity === 'error');
  const codes   = Array.from(new Set(diags.items.map(d => d.code).filter(Boolean))).sort();
  const summary = codes.length ? codes.join(' ') : '—';
  console.log(`  ${f.padEnd(pad)}  ${errs.length}E  ${summary}`);
}
