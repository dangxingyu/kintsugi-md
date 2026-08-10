/**
 * Run the parser across a real corpus and report what it did.
 *
 * The test suite proves the parser handles cases someone thought of. This asks
 * a different and harder question: turned loose on thousands of documents
 * nobody curated, does it crash, lose content, or "repair" things that were
 * never broken?
 *
 * The headline number is the repair rate on READMEs. Those are human-authored
 * and mostly well-formed, so a high rate there means over-eager repair — the
 * failure mode that makes a tolerant parser worse than a strict one.
 *
 * Usage: node scripts/corpus-check.mjs <corpus.jsonl> [label]
 */
import { readFileSync } from 'node:fs';
import { parse, renderHtml } from '../dist/index.js';

const path = process.argv[2];
const label = process.argv[3] ?? path;
if (!path) {
  console.error('usage: node scripts/corpus-check.mjs <corpus.jsonl> [label]');
  process.exit(1);
}

const docs = readFileSync(path, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((o) => o && typeof o.text === 'string');

let throws = 0;
let internalErrors = 0;
let contentLoss = 0;
let totalRepairs = 0;
let docsWithRepair = 0;
let totalChars = 0;
const byCode = {};
const slowest = [];
const examples = {};

/** Strip markup to compare visible words in vs out — a coarse content-loss check. */
function words(s) {
  return (s.match(/[\p{L}\p{N}]{3,}/gu) ?? []).length;
}

const t0 = performance.now();
for (const d of docs) {
  const src = d.text;
  totalChars += src.length;
  let res;
  const ts = performance.now();
  try {
    res = parse(src);
    renderHtml(res.ast);
  } catch (e) {
    throws++;
    continue;
  }
  const ms = performance.now() - ts;
  slowest.push({ ms, len: src.length, repo: d.repo ?? d.file ?? '' });

  const internal = res.diagnostics.filter((x) => /Internal parser error/.test(x.message));
  if (internal.length) internalErrors++;

  // Content check: every word in the source should still be reachable in the
  // AST. Scaffolding is the one sanctioned omission, so skip docs containing it.
  const json = JSON.stringify(res.ast);
  if (!/scaffolding/.test(json)) {
    const inWords = words(src);
    const outWords = words(json);
    if (inWords > 50 && outWords < inWords * 0.9) contentLoss++;
  }

  const repairs = res.diagnostics.filter((x) => x.severity === 'repair');
  if (repairs.length) docsWithRepair++;
  totalRepairs += repairs.length;
  for (const r of repairs) {
    byCode[r.code] = (byCode[r.code] ?? 0) + 1;
    if (!examples[r.code]) {
      const line = src.split('\n')[r.line - 1] ?? '';
      examples[r.code] = line.trim().slice(0, 90);
    }
  }
}
const elapsed = performance.now() - t0;

slowest.sort((a, b) => b.ms - a.ms);

console.log(`\n=== ${label} ===`);
console.log(`documents           ${docs.length}`);
console.log(`total size          ${(totalChars / 1048576).toFixed(1)} MB`);
console.log(`wall clock          ${(elapsed / 1000).toFixed(1)}s  (${(totalChars / 1048576 / (elapsed / 1000)).toFixed(1)} MB/s)`);
console.log(`slowest document    ${slowest[0]?.ms.toFixed(0)}ms (${slowest[0]?.len} chars) ${slowest[0]?.repo ?? ''}`);
console.log('');
console.log(`throws              ${throws}`);
console.log(`internal errors     ${internalErrors}`);
console.log(`suspected loss      ${contentLoss}`);
console.log('');
console.log(`docs with a repair  ${docsWithRepair} / ${docs.length}  (${((docsWithRepair / docs.length) * 100).toFixed(1)}%)`);
console.log(`repairs per doc     ${(totalRepairs / Math.max(docs.length, 1)).toFixed(2)}`);
console.log('\nrepairs by code (most frequent first):');
Object.entries(byCode)
  .sort((a, b) => b[1] - a[1])
  .forEach(([code, n]) => {
    const pct = ((n / Math.max(totalRepairs, 1)) * 100).toFixed(1);
    console.log(`  ${String(n).padStart(6)}  ${pct.padStart(5)}%  ${code}`);
    console.log(`          e.g. ${JSON.stringify(examples[code])}`);
  });
