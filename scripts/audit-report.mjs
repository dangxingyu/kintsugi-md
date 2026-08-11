/**
 * Aggregate judged audit verdicts into a precision report.
 *
 * Reads the judge output (JSONL of verdicts) plus the corpus firing counts, and
 * reports both the raw sample precision and the volume-weighted precision.
 *
 * The weighted figure is the one that matters. The sample gives every
 * diagnostic code the same 25 rows regardless of how often it actually fires,
 * so a code that misfires 5,000 times and one that misfires 5 times count
 * equally in the raw number. Weighting by real firing volume answers the
 * question a user actually has: of the repairs this parser performs on my
 * documents, what fraction are doing something useful?
 *
 * Usage: node scripts/audit-report.mjs <verdicts.jsonl> <firings.json>
 */
import { readFileSync } from 'node:fs';

const verdictsPath = process.argv[2] ?? 'data/audit-verdicts.jsonl';
const firingsPath = process.argv[3] ?? 'data/audit-firings.json';

const verdicts = readFileSync(verdictsPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const firings = JSON.parse(readFileSync(firingsPath, 'utf8'));

const SHORT = { TRUE_REPAIR: 'T', FALSE_POSITIVE: 'F', HARMLESS: 'H', UNCLEAR: 'U' };

const byCode = {};
for (const v of verdicts) {
  byCode[v.code] ??= { T: 0, F: 0, H: 0, U: 0 };
  byCode[v.code][SHORT[v.verdict] ?? 'U']++;
}

const totals = { T: 0, F: 0, H: 0, U: 0 };
for (const v of verdicts) totals[SHORT[v.verdict] ?? 'U']++;

let wBad = 0;
let wGood = 0;
let wHarm = 0;
const rows = [];
for (const [code, c] of Object.entries(byCode)) {
  const n = c.T + c.F + c.H + c.U;
  const vol = firings[code] ?? 0;
  const bad = (vol * c.F) / Math.max(n, 1);
  const good = (vol * c.T) / Math.max(n, 1);
  const harm = (vol * c.H) / Math.max(n, 1);
  wBad += bad;
  wGood += good;
  wHarm += harm;
  rows.push({ code, ...c, vol, bad: Math.round(bad), good: Math.round(good) });
}
rows.sort((a, b) => b.bad - a.bad);

const samplePrecision = totals.T / Math.max(totals.T + totals.F, 1);
const weightedPrecision = wGood / Math.max(wGood + wBad, 1);

console.log('=== sample ===');
console.log(`  judged        ${verdicts.length}`);
console.log(`  true repair   ${totals.T}`);
console.log(`  false pos     ${totals.F}`);
console.log(`  harmless      ${totals.H}`);
console.log(`  unclear       ${totals.U}`);
console.log(`  precision     ${samplePrecision.toFixed(3)}`);

console.log('\n=== weighted by real firing volume ===');
console.log(`  good firings  ~${Math.round(wGood)}`);
console.log(`  bad firings   ~${Math.round(wBad)}`);
console.log(`  harmless      ~${Math.round(wHarm)}`);
console.log(`  precision     ${weightedPrecision.toFixed(3)}`);

console.log('\n=== per code, worst first ===');
console.log('  code                              T   F   H  firings    bad   good');
for (const r of rows) {
  console.log(
    `  ${r.code.padEnd(32)}${String(r.T).padStart(3)}${String(r.F).padStart(4)}${String(r.H).padStart(4)}` +
      `${String(r.vol).padStart(9)}${String(r.bad).padStart(7)}${String(r.good).padStart(7)}`,
  );
}

const netPositive = rows.filter((r) => r.good > r.bad);
console.log(`\nnet-positive heuristics: ${netPositive.length}/${rows.length}`);
for (const r of netPositive) console.log(`  ${r.code} (+${r.good - r.bad})`);
