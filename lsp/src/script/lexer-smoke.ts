// Smoke test: tokenize one .bac file and print a brief summary.
// Run via:  npx tsx lsp/src/script/lexer-smoke.ts <file.bac>
import * as fs from 'node:fs';
import { tokenize } from './lexer';
import { BacDiagnostics } from './diagnostics';
import { BacTokenKind, tokenKindName } from './token';

const path = process.argv[2];
if (!path) { console.error('usage: lexer-smoke <file.bac>'); process.exit(2); }

const source = fs.readFileSync(path, 'utf8');
const diags  = new BacDiagnostics();
const tokens = tokenize(source, diags);

const counts = new Map<BacTokenKind, number>();
for (const t of tokens) {
  counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
}
console.log(`tokens=${tokens.length}  diagnostics=${diags.items.length}`);
const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
for (const [kind, n] of sorted.slice(0, 12)) {
  console.log(`  ${tokenKindName(kind).padEnd(14)} ${n}`);
}
if (diags.items.length > 0) {
  console.log('--- diagnostics ---');
  for (const d of diags.items) {
    console.log(`  ${d.severity} [${d.code}] ${d.location.line}:${d.location.column}  ${d.message}`);
  }
}
