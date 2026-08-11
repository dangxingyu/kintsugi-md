/**
 * Pull judged verdicts out of a workflow journal into a flat JSONL.
 *
 * The judging runs as parallel agents whose results land in the workflow's
 * journal; this collects them so `audit-report.mjs` can aggregate. Kept
 * separate so a partial run (some judges still going, or some failed) can
 * still be reported on, with the coverage stated rather than assumed.
 *
 * Usage: node scripts/audit-collect.mjs <journal.jsonl> [out.jsonl]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const journalPath = process.argv[2];
const outPath = process.argv[3] ?? 'data/audit-verdicts.jsonl';
if (!journalPath) {
  console.error('usage: node scripts/audit-collect.mjs <journal.jsonl> [out.jsonl]');
  process.exit(1);
}

const verdicts = [];
const summaries = [];
let started = 0;
let results = 0;

for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if (o.type === 'started') started++;
  if (o.type !== 'result' || !o.result) continue;
  results++;
  if (Array.isArray(o.result.verdicts)) verdicts.push(...o.result.verdicts);
  if (o.result.summary) summaries.push(o.result.summary);
}

writeFileSync(outPath, verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');

const codes = new Set(verdicts.map((v) => v.code));
console.log(`journal: ${results} agent results (${started} starts)`);
console.log(`collected ${verdicts.length} verdicts across ${codes.size} diagnostic codes`);
if (summaries.length) {
  const recs = {};
  for (const s of summaries) recs[s.recommendation] = (recs[s.recommendation] ?? 0) + 1;
  console.log(`recommendations: ${JSON.stringify(recs)}`);
}
console.log(`wrote ${outPath}`);
