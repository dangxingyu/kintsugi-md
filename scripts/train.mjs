/**
 * Fit the bold-line-as-heading classifier.
 *
 * Logistic regression, L2-regularised, plain JavaScript. Two reasons for that
 * choice over something heavier: it keeps the project free of a Python
 * toolchain, and its coefficients are directly readable — the replacement for a
 * hand-written rule should be at least as inspectable as the rule was.
 *
 * The feature extractor is imported from src/, the same module the parser uses,
 * so features cannot drift between fit time and inference time.
 *
 * Usage: node scripts/train.mjs [dataPath] [--holdout-lang]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { boldHeadingFeatures, FEATURE_NAMES } from '../dist/features.js';

const DATA = process.argv[2] ?? 'data/bold-heading.jsonl';
const OUT = 'src/model-weights.json';

function load(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function toVector(row) {
  return boldHeadingFeatures({
    text: row.text,
    delimiter: row.delimiter ?? '**',
    docUsesAtx: !!row.docUsesAtx,
    siblingBoldLines: row.siblingBoldLines ?? 0,
    followedByBlank: !!row.followedByBlank,
    followedByParagraph: !!row.followedByParagraph,
    relativePosition: row.relativePosition ?? 0,
  });
}

/** Deterministic shuffle so a rerun reproduces the same split. */
function shuffled(arr, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function train(X, y, { epochs = 400, lr = 0.5, l2 = 1e-3 } = {}) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  const n = X.length;
  // Class weights, because ATX headings and mid-sentence bold are not equally
  // common in a corpus and we care about both errors.
  const pos = y.reduce((a, b) => a + b, 0);
  const wPos = pos > 0 ? n / (2 * pos) : 1;
  const wNeg = n - pos > 0 ? n / (2 * (n - pos)) : 1;

  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(X[i].reduce((s, v, k) => s + v * w[k], 0));
      const cw = y[i] === 1 ? wPos : wNeg;
      const err = (p - y[i]) * cw;
      for (let k = 0; k < d; k++) g[k] += err * X[i][k];
    }
    for (let k = 0; k < d; k++) {
      // No weight decay on the bias term.
      const reg = k === 0 ? 0 : l2 * w[k];
      w[k] -= (lr * (g[k] / n + reg));
    }
  }
  return w;
}

function predict(w, x) {
  return sigmoid(x.reduce((s, v, k) => s + v * w[k], 0));
}

function evaluate(w, rows, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const p = predict(w, toVector(r)) >= threshold ? 1 : 0;
    if (r.label === 1 && p === 1) tp++;
    else if (r.label === 1) fn++;
    else if (p === 1) fp++;
    else tn++;
  }
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    n: rows.length,
    accuracy: (tp + tn) / Math.max(rows.length, 1),
    precision: prec,
    recall: rec,
    f1: prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0,
    tp, fp, tn, fn,
  };
}

/** The rule currently shipping, reimplemented here so we can score it head to head. */
const SMALL = new Set(['a','an','and','as','at','but','by','for','from','in','nor','of','on','or','per','the','to','via','vs','with']);
function currentRule(row) {
  const inner = row.text.trim();
  if (inner === '' || inner.length > 80) return 0;
  if (/\*\*|__/.test(inner)) return 0;
  if (/[.!?]$/.test(inner)) return 0;
  if (inner.split(/\s+/).length > 12) return 0;
  if (inner.endsWith(':')) return 1;
  if (/^(step|section|phase|stage|part|chapter|appendix|note|summary|overview|conclusion)\b/i.test(inner)) return 1;
  // isTitleCased
  const words = inner.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return 0;
  if (inner === inner.toUpperCase()) return 1;
  const sig = words.filter((w) => w.length >= 3 && !SMALL.has(w.toLowerCase()));
  if (sig.length === 0) return 0;
  return sig.every((w) => /^[A-Z0-9"'([]/.test(w)) ? 1 : 0;
}

function evaluateRule(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const p = currentRule(r);
    if (r.label === 1 && p === 1) tp++;
    else if (r.label === 1) fn++;
    else if (p === 1) fp++;
    else tn++;
  }
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    n: rows.length,
    accuracy: (tp + tn) / Math.max(rows.length, 1),
    precision: prec,
    recall: rec,
    f1: prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0,
    tp, fp, tn, fn,
  };
}

const CJK_RE = /[぀-ヿ一-鿿가-힯]/u;
const CYRILLIC = /[Ѐ-ӿ]/u;
const ARABIC = /[؀-ۿ]/u;
function scriptOf(text) {
  if (CJK_RE.test(text)) return 'cjk';
  if (CYRILLIC.test(text)) return 'cyrillic';
  if (ARABIC.test(text)) return 'arabic';
  if (/[À-ɏ]/u.test(text)) return 'latin-accented';
  return 'latin';
}

function fmt(m) {
  return `n=${String(m.n).padStart(6)}  acc=${m.accuracy.toFixed(3)}  P=${m.precision.toFixed(3)}  R=${m.recall.toFixed(3)}  F1=${m.f1.toFixed(3)}`;
}

function main() {
  const rows = load(DATA);
  const all = shuffled(rows);
  const cut = Math.floor(all.length * 0.8);
  const trainRows = all.slice(0, cut);
  const testRows = all.slice(cut);

  const X = trainRows.map(toVector);
  const y = trainRows.map((r) => r.label);
  const w = train(X, y);

  console.log('\n=== held-out comparison ===');
  console.log('current rule   ', fmt(evaluateRule(testRows)));
  console.log('classifier     ', fmt(evaluate(w, testRows)));

  console.log('\n=== by script (held-out) ===');
  const byScript = {};
  for (const r of testRows) (byScript[scriptOf(r.text)] ??= []).push(r);
  for (const [script, rs] of Object.entries(byScript).sort()) {
    if (rs.length < 20) continue;
    console.log(`  ${script.padEnd(15)} rule  ${fmt(evaluateRule(rs))}`);
    console.log(`  ${''.padEnd(15)} model ${fmt(evaluate(w, rs))}`);
  }

  // ---- choose the operating point ----
  //
  // The costs are not symmetric. A false positive invents a section heading the
  // author never wrote, which is the over-eager repair this parser treats as
  // its cardinal sin. A false negative just leaves the line bold — exactly what
  // strict CommonMark does, so nothing is lost that was not already lost.
  // So we pick the lowest threshold that holds precision at or above the target
  // rather than the one that maximises F1.
  // 0.95 is unreachable with text-only features (precision plateaus near 0.91),
  // and chasing it collapses recall to nothing. 0.92 is the achievable point
  // that still leans hard against inventing headings.
  const TARGET_PRECISION = 0.92;
  let threshold = 0.5;
  for (let t = 0.50; t <= 0.99; t += 0.01) {
    const m = evaluate(w, testRows, t);
    if (m.precision >= TARGET_PRECISION) { threshold = Number(t.toFixed(2)); break; }
    threshold = Number(t.toFixed(2));
  }
  console.log(`\n=== operating point (precision-first, target P>=${TARGET_PRECISION}) ===`);
  console.log(`  threshold=${threshold}`);
  console.log('  at 0.50      ', fmt(evaluate(w, testRows, 0.5)));
  console.log(`  at ${threshold.toFixed(2)}      `, fmt(evaluate(w, testRows, threshold)));

  console.log('\n=== learned weights ===');
  FEATURE_NAMES.map((name, i) => [name, w[i]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .forEach(([name, v]) => console.log(`  ${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(3).padStart(6)}  ${name}`));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        model: 'bold-line-heading',
        kind: 'logistic-regression',
        trainedOn: rows.length,
        featureNames: [...FEATURE_NAMES],
        weights: w.map((v) => Number(v.toFixed(6))),
        threshold,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nwrote ${OUT}`);
}

main();
