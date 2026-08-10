/**
 * Evaluate rule vs classifier on the hand-labelled gold set.
 *
 * The training data comes from distant supervision on READMEs, so held-out
 * accuracy there shares the corpus's biases. The gold set is written by hand,
 * deliberately adversarial, and covers the scripts where the rule is blind — so
 * it is the honest test of whether anything actually generalised.
 *
 * Usage: node scripts/eval-gold.mjs [goldPath]
 */
import { readFileSync } from 'node:fs';
import { boldHeadingFeatures } from '../dist/features.js';

const GOLD = process.argv[2] ?? 'data/gold-eval.jsonl';
const MODEL = JSON.parse(readFileSync('src/model-weights.json', 'utf8'));

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * A bold-only line in the wild is almost always followed by a blank line and
 * then a paragraph, so those are the neutral defaults for gold rows, which
 * carry text and label only.
 */
function score(text) {
  const x = boldHeadingFeatures({
    text,
    delimiter: '**',
    docUsesAtx: false,
    siblingBoldLines: 0,
    followedByBlank: true,
    followedByParagraph: true,
    relativePosition: 0.5,
  });
  return sigmoid(x.reduce((s, v, i) => s + v * MODEL.weights[i], 0));
}

const SMALL = new Set(['a','an','and','as','at','but','by','for','from','in','nor','of','on','or','per','the','to','via','vs','with']);
function currentRule(inner) {
  if (inner === '' || inner.length > 80) return 0;
  if (/\*\*|__/.test(inner)) return 0;
  if (/[.!?]$/.test(inner)) return 0;
  if (inner.split(/\s+/).length > 12) return 0;
  if (inner.endsWith(':')) return 1;
  if (/^(step|section|phase|stage|part|chapter|appendix|note|summary|overview|conclusion)\b/i.test(inner)) return 1;
  const words = inner.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return 0;
  if (inner === inner.toUpperCase() && /[A-Z]/.test(inner)) return 1;
  const sig = words.filter((w) => w.length >= 3 && !SMALL.has(w.toLowerCase()));
  if (sig.length === 0) return 0;
  return sig.every((w) => /^[A-Z0-9"'([]/.test(w)) ? 1 : 0;
}

const rows = readFileSync(GOLD, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

function metrics(rows, predict) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const p = predict(r.text);
    if (r.label === 1 && p === 1) tp++;
    else if (r.label === 1) fn++;
    else if (p === 1) fp++;
    else tn++;
  }
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    n: rows.length,
    acc: (tp + tn) / Math.max(rows.length, 1),
    f1: prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0,
    tp, fp, tn, fn,
  };
}

const ruleP = (t) => currentRule(t.trim());
const modelP = (t) => (score(t) >= MODEL.threshold ? 1 : 0);

const fmt = (m) => `n=${String(m.n).padStart(3)} acc=${m.acc.toFixed(3)} F1=${m.f1.toFixed(3)}  (tp=${m.tp} fp=${m.fp} tn=${m.tn} fn=${m.fn})`;

console.log('=== threshold sweep on gold ===');
console.log('  thr    acc     F1     tp  fp  tn  fn');
for (let t = 0.30; t <= 0.85; t += 0.05) {
  const m = metrics(rows, (x) => (score(x) >= t ? 1 : 0));
  console.log(`  ${t.toFixed(2)}  ${m.acc.toFixed(3)}  ${m.f1.toFixed(3)}  ${String(m.tp).padStart(3)} ${String(m.fp).padStart(3)} ${String(m.tn).padStart(3)} ${String(m.fn).padStart(3)}`);
}

// The rule is high-precision and low-recall; the model is the opposite. Union
// them: the rule fires on what it is sure of, the model covers everything else.
const hybridP = (t) => (ruleP(t) === 1 || modelP(t) === 1 ? 1 : 0);

console.log('\n=== gold set, overall ===');
console.log('  rule  ', fmt(metrics(rows, ruleP)));
console.log('  model ', fmt(metrics(rows, modelP)));
console.log('  hybrid', fmt(metrics(rows, hybridP)));

console.log('\n=== by language ===');
const byLang = {};
for (const r of rows) (byLang[r.language] ??= []).push(r);
for (const [lang, rs] of Object.entries(byLang).sort()) {
  const rm = metrics(rs, ruleP);
  const mm = metrics(rs, modelP);
  const hm = metrics(rs, hybridP);
  console.log(`  ${lang.padEnd(11)} rule=${rm.acc.toFixed(2)}  model=${mm.acc.toFixed(2)}  hybrid=${hm.acc.toFixed(2)}   (n=${rs.length})`);
}

console.log('\n=== cases the hybrid still gets wrong ===');
let wrong = 0;
for (const r of rows) {
  const p = hybridP(r.text);
  if (p !== r.label) {
    wrong++;
    console.log(`  want=${r.label} got=${p} p=${score(r.text).toFixed(2)}  ${JSON.stringify(r.text)}  [${r.language}] ${r.note ?? ''}`);
  }
}
if (wrong === 0) console.log('  (none)');
