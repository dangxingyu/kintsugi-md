/**
 * Sample repair diagnostics for a false-positive audit.
 *
 * The corpus run showed 51.6% of human-authored READMEs triggering a
 * repair-severity diagnostic. That number is meaningless without knowing its
 * composition: a repair on genuinely broken markdown is the product working,
 * a repair on valid markdown is the failure mode the whole design is supposed
 * to prevent.
 *
 * For each sampled diagnostic this extracts a window of source around it and
 * renders that window twice — once with Kintsugi, once with markdown-it (a
 * mainstream CommonMark+GFM parser) — so a judge can see exactly what the
 * repair changed relative to what a normal parser would have produced.
 *
 * Localising to a window matters: comparing whole documents cannot attribute a
 * difference to one diagnostic.
 *
 * Usage: node scripts/audit-sample.mjs <corpus.jsonl> [perCode] [outPath]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { parse, renderHtml } from '../dist/index.js';

const require = createRequire(import.meta.url);
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({ html: true, linkify: false });

const corpusPath = process.argv[2] ?? 'data/readmes.jsonl';
const PER_CODE = Number(process.argv[3] ?? 25);
const outPath = process.argv[4] ?? 'data/audit-sample.jsonl';

const WINDOW = 4; // lines of context either side

/** Deterministic PRNG so the sample is reproducible. */
let seed = 20260810;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

/** Collapse whitespace so trivial formatting differences do not count. */
const norm = (h) => h.replace(/\s+/g, ' ').replace(/> </g, '><').trim();

const docs = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter((o) => o && typeof o.text === 'string');

const byCode = new Map();

for (const d of docs) {
  let res;
  try {
    res = parse(d.text);
  } catch {
    continue;
  }
  const lines = d.text.replace(/\r\n?/g, '\n').split('\n');

  for (const diag of res.diagnostics) {
    if (diag.severity !== 'repair') continue;
    const bucket = byCode.get(diag.code) ?? [];
    // Reservoir sampling: keeps the sample uniform over all firings of this
    // code without holding every one of them in memory.
    bucket.total = (bucket.total ?? 0) + 1;
    if (bucket.length < PER_CODE) {
      bucket.push({ d, diag, lines });
    } else if (rnd() < PER_CODE / bucket.total) {
      bucket[Math.floor(rnd() * PER_CODE)] = { d, diag, lines };
    }
    byCode.set(diag.code, bucket);
  }
}

const rows = [];
for (const [code, bucket] of byCode) {
  for (const { d, diag, lines } of bucket) {
    const start = Math.max(0, diag.line - 1 - WINDOW);
    const end = Math.min(lines.length, diag.line + WINDOW);
    const snippet = lines.slice(start, end).join('\n');
    if (snippet.trim() === '') continue;

    let kintsugi = '';
    let reference = '';
    let snippetDiags = [];
    try {
      const r = parse(snippet);
      kintsugi = renderHtml(r.ast);
      snippetDiags = r.diagnostics.filter((x) => x.severity === 'repair').map((x) => x.code);
    } catch (e) {
      kintsugi = `<!-- threw: ${e.message} -->`;
    }
    try {
      reference = md.render(snippet);
    } catch (e) {
      reference = `<!-- markdown-it threw: ${e.message} -->`;
    }

    rows.push({
      code,
      message: diag.message,
      line: diag.line,
      repo: d.repo ?? d.file ?? '',
      focusLine: lines[diag.line - 1] ?? '',
      snippet,
      kintsugiHtml: kintsugi,
      referenceHtml: reference,
      // Did the repair actually change anything a reader would see?
      identical: norm(kintsugi) === norm(reference),
      reproducesInSnippet: snippetDiags.includes(code),
      totalFirings: bucket.total,
    });
  }
}

// Stable per-code ids. The judging workflow returns verdicts keyed by id, and
// a resumed run replays cached agents into the same journal, so the collector
// dedupes on this — without it, replayed families get counted twice.
const perCode = new Map();
for (const r of rows) {
  const seen = perCode.get(r.code) ?? [];
  r.id = `${r.code}#${seen.length}`;
  seen.push(r);
  perCode.set(r.code, seen);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// One file per code, which is what the judging agents read — each agent takes
// a family of related codes so it can see them in context.
const splitDir = `${dirname(outPath)}/audit`;
mkdirSync(splitDir, { recursive: true });
for (const [code, list] of perCode) {
  writeFileSync(`${splitDir}/${code}.jsonl`, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Emit the firing counts alongside the sample. The weighted precision figure
// multiplies each code's judged rate by how often that code actually fires, so
// the two files have to describe the same parser run — a hand-maintained count
// silently reports the old parser's volume against the new parser's verdicts.
const firingsPath = outPath.replace(/(\.jsonl)?$/, '').replace(/-sample$/, '') + '-firings.json';
const firings = Object.fromEntries(
  [...byCode].sort((a, b) => b[1].total - a[1].total).map(([code, b]) => [code, b.total]),
);
writeFileSync(firingsPath, JSON.stringify(firings, null, 2) + '\n');

console.log(`sampled ${rows.length} diagnostics across ${byCode.size} codes\n`);
console.log('code                              firings   sampled   identical-to-reference');
for (const [code, bucket] of [...byCode].sort((a, b) => b[1].total - a[1].total)) {
  const mine = rows.filter((r) => r.code === code);
  const same = mine.filter((r) => r.identical).length;
  console.log(
    `  ${code.padEnd(32)} ${String(bucket.total).padStart(6)}   ${String(mine.length).padStart(6)}   ${String(same).padStart(4)}/${mine.length}`,
  );
}
console.log(`\nwrote ${outPath}`);
console.log(`wrote ${firingsPath}`);
