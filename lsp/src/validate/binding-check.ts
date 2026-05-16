// 1:1 port of BacBindingCheck.cpp (plugin Validate/ pass).
//
// Wire-stable diagnostic codes: BAC3140 (binding target not declared on the
// class) and BAC3142 (binding RHS not an identifier). BAC3141 (property
// bindability — existence of `<Name>Delegate` on the widget class) stays
// plugin-only because it requires engine reflection.
//
// Runs alongside the References pass — script-only symbol resolution is the
// right peer.

import { BacDiagnostics } from '../script/diagnostics';
import * as ast from '../script/ast';

export function runBindingCheck(scriptAst: ast.BacScriptAst, out: BacDiagnostics): void {
  const cls = scriptAst.class;
  if (!cls) { return; }   // interface/struct/enum/asset/table can't host widgets

  const sym = buildSymbols(cls);
  for (const m of cls.members) {
    if (m.kind !== 'widget') { continue; }
    walkWidget(m, sym, out);
  }
}

interface BindingSymbols {
  functionNames: Set<string>;
  variableNames: Set<string>;
  memberNames:   string[];   // union, for fuzzy "did you mean"
}

function buildSymbols(cls: ast.BacClassDecl): BindingSymbols {
  const sym: BindingSymbols = {
    functionNames: new Set(),
    variableNames: new Set(),
    memberNames:   [],
  };
  for (const m of cls.members) {
    switch (m.kind) {
      case 'function':
        sym.functionNames.add(m.name);
        sym.memberNames.push(m.name);
        break;
      case 'variable':
        sym.variableNames.add(m.name);
        sym.memberNames.push(m.name);
        break;
      default: break;
    }
  }
  return sym;
}

function walkWidget(w: ast.BacWidgetDecl, sym: BindingSymbols, out: BacDiagnostics): void {
  for (const a of w.defaults) {
    if (!a.isBinding) { continue; }

    // BAC3142 — RHS must be a bare identifier.
    if (!a.value || a.value.kind !== 'ident') {
      out.items.push({
        severity: 'error',
        code:     'BAC3142',
        location: a.location,
        message:  `Widget '${w.name}' binding '${a.name} =>': RHS must be a function or variable identifier.`,
      });
      continue;
    }

    const target = a.value.name;
    if (sym.functionNames.has(target) || sym.variableNames.has(target)) { continue; }

    // No self-declared members at all → likely inherited binding; skip
    // rather than flood the diagnostics. The plugin's generator backstops
    // this with engine reflection.
    if (sym.memberNames.length === 0) { continue; }

    const suggested = closestMatch(target, sym.memberNames);
    const fix = suggested
      ? { hint: `Did you mean '${suggested}'?`, fixes: [`replace \`=> ${target}\` with \`=> ${suggested}\``] }
      : {};
    out.items.push({
      severity: 'error',
      code:     'BAC3140',
      location: a.location,
      message:  `Widget '${w.name}' binding '${a.name} => ${target}': target is not a declared function or variable on this class.`,
      ...fix,
    });
  }
  for (const child of w.children) { walkWidget(child, sym, out); }
}

// Local copy of the closest-match helper from reference-check.ts. Keeping it
// inline so the binding pass has no dependency on a non-exported sibling.
function closestMatch(target: string, candidates: string[]): string | undefined {
  if (candidates.length === 0 || !target) { return undefined; }
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(target, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  const cutoff = Math.max(2, Math.ceil(target.length / 3));
  return bestDist <= cutoff ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) { return n; }
  if (n === 0) { return m; }
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) { dp[j] = j; }
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}
