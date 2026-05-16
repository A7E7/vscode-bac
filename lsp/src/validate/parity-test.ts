// Parity assertion runner for the validator wire-stable contract.
//
// The BlueprintAsCode plugin owns `Tests/Corpus/parity_manifest.json` —
// the single source of truth for which diagnostic codes (and how many of
// each) every shared fixture must produce. Both ports must reproduce the
// counts exactly; this script asserts the TS side. The C++ side is
// asserted by the `BAC.Validate.ParityManifest` automation test in the
// plugin repo.
//
// Usage:
//   node out/validate/parity-test.js [pluginRoot]
//
// Resolution order for the plugin root:
//   1. CLI arg
//   2. $BAC_PLUGIN_ROOT env var
//   3. Sibling layout default: ../BACSample/Plugins/BlueprintAsCode
//      (resolved from this file's location)
//
// `AstOnly+Identifiers` entries are skipped — those need engine
// reflection that lives only in the C++ pipeline.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tokenize } from '../script/lexer';
import { parse } from '../script/parser';
import { BacDiagnostics } from '../script/diagnostics';
import { runBindingCheck } from './binding-check';
import { runContractCheck } from './contract-check';
import { runReferenceCheck } from './reference-check';
import { runTypeCheck } from './type-check';

interface ManifestEntry {
  path: string;
  passes: 'AstOnly' | 'AstOnly+Identifiers';
  expected_error_codes: Record<string, number>;
}

interface Manifest {
  version: number;
  fixtures: ManifestEntry[];
}

function resolvePluginRoot(): string {
  const fromArg = process.argv[2];
  if (fromArg) { return path.resolve(fromArg); }

  const fromEnv = process.env.BAC_PLUGIN_ROOT;
  if (fromEnv) { return path.resolve(fromEnv); }

  // Two fallbacks, tried in order:
  //   1. Sibling-repo layout — `~/UnrealProjects/vscode-bac/lsp/out/validate/`
  //      → `~/UnrealProjects/BACSample/Plugins/BlueprintAsCode/`. Works on
  //      the dev machine when both repos are checked out side by side.
  //   2. Vendored corpus at `<vscode-bac>/test/parity-corpus/`. Used by CI
  //      (the public repo can't access the private plugin) and by anyone
  //      cloning vscode-bac standalone.
  const here = __dirname; // .../lsp/out/validate
  const sibling = path.resolve(here, '..', '..', '..', '..', 'BACSample', 'Plugins', 'BlueprintAsCode');
  if (fs.existsSync(path.join(sibling, 'Tests', 'Corpus', 'parity_manifest.json'))) {
    return sibling;
  }
  // From .../lsp/out/validate/ → .../test/parity-corpus/
  return path.resolve(here, '..', '..', '..', 'test', 'parity-corpus');
}

function loadManifest(pluginRoot: string): Manifest {
  const manifestPath = path.join(pluginRoot, 'Tests', 'Corpus', 'parity_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`parity manifest not found at ${manifestPath} (set BAC_PLUGIN_ROOT or pass the plugin root as argv[2])`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Manifest;
  if (parsed.version !== 1) {
    throw new Error(`parity manifest version ${parsed.version} unsupported (this runner expects v1)`);
  }
  return parsed;
}

function countErrorsWithCode(diags: BacDiagnostics, code: string): number {
  let n = 0;
  for (const d of diags.items) {
    if (d.severity === 'error' && d.code === code) { n++; }
  }
  return n;
}

interface RunResult {
  fixture: string;
  passes: string;
  status: 'pass' | 'fail' | 'skip';
  mismatches: string[];
}

function runOne(pluginRoot: string, entry: ManifestEntry): RunResult {
  if (entry.passes === 'AstOnly+Identifiers') {
    return { fixture: entry.path, passes: entry.passes, status: 'skip', mismatches: [] };
  }

  const fixtureFull = path.join(pluginRoot, entry.path);
  if (!fs.existsSync(fixtureFull)) {
    return {
      fixture: entry.path,
      passes: entry.passes,
      status: 'fail',
      mismatches: [`fixture file missing on disk: ${fixtureFull}`],
    };
  }

  const source = fs.readFileSync(fixtureFull, 'utf8');
  const diags = new BacDiagnostics();
  const tokens = tokenize(source, diags);
  const ast = parse(tokens, diags);
  runContractCheck(ast, diags);
  runReferenceCheck(ast, diags);
  runBindingCheck(ast, diags);
  runTypeCheck(ast, diags);

  const mismatches: string[] = [];
  for (const [code, expected] of Object.entries(entry.expected_error_codes)) {
    const actual = countErrorsWithCode(diags, code);
    if (actual !== expected) {
      mismatches.push(`${code}: expected ${expected}, got ${actual}`);
    }
  }
  return {
    fixture: entry.path,
    passes: entry.passes,
    status: mismatches.length === 0 ? 'pass' : 'fail',
    mismatches,
  };
}

function main(): number {
  const pluginRoot = resolvePluginRoot();
  console.log(`parity-test: plugin root = ${pluginRoot}`);

  let manifest: Manifest;
  try {
    manifest = loadManifest(pluginRoot);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }

  const results: RunResult[] = [];
  for (const entry of manifest.fixtures) {
    results.push(runOne(pluginRoot, entry));
  }

  let pad = 0;
  for (const r of results) { pad = Math.max(pad, r.fixture.length); }

  let nPass = 0, nFail = 0, nSkip = 0;
  for (const r of results) {
    const tag =
      r.status === 'pass' ? 'PASS' :
      r.status === 'skip' ? 'SKIP' :
                            'FAIL';
    console.log(`  [${tag}] ${r.fixture.padEnd(pad)}  (${r.passes})`);
    for (const m of r.mismatches) {
      console.log(`           ${m}`);
    }
    if (r.status === 'pass') { nPass++; }
    else if (r.status === 'skip') { nSkip++; }
    else { nFail++; }
  }

  console.log('');
  console.log(`parity-test: ${nPass} passed, ${nFail} failed, ${nSkip} skipped (${results.length} total)`);
  if (nSkip > 0) {
    console.log('             skipped entries need the engine-coupled Identifiers pass — C++ port covers them.');
  }
  return nFail === 0 ? 0 : 1;
}

process.exit(main());
