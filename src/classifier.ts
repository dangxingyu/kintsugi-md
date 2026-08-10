/**
 * The learned half of the bold-line-as-heading decision.
 *
 * Design constraints this had to satisfy before it was allowed anywhere near
 * the parse path:
 *
 *   Deterministic. Weights are pinned in the repository and loaded as data. The
 *   same input scores identically on every machine and every run, which a
 *   parser needs — non-reproducible output breaks caching and diffing far more
 *   painfully than a mis-parsed edge case does.
 *
 *   Inspectable. Logistic regression, so `explain()` can report exactly which
 *   features moved the decision and by how much. That is strictly more
 *   auditable than the hand-tuned boolean chain it replaces, where the
 *   interaction between seven conditions was opaque even to its author.
 *
 *   Free when unused. No allocation, no I/O, a couple of dozen multiply-adds.
 *
 * The model proposes; it never disposes. Hard invariants — never throw, never
 * delete content, bounded depth and time — remain rules that wrap this.
 */
import type { BoldLineContext } from './features.js';
import { boldHeadingFeatures, FEATURE_NAMES } from './features.js';
import weightsJson from './model-weights.json' with { type: 'json' };

interface ModelFile {
  model: string;
  kind: string;
  featureNames: string[];
  weights: number[];
  threshold: number;
}

const MODEL = weightsJson as ModelFile;

/**
 * Guard against the classic silent-corruption bug: weights retrained against a
 * different feature order than the extractor now emits. Cheap to check once.
 */
const WEIGHTS_VALID =
  MODEL.weights.length === FEATURE_NAMES.length &&
  MODEL.featureNames.length === FEATURE_NAMES.length &&
  MODEL.featureNames.every((n, i) => n === FEATURE_NAMES[i]);

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** Probability that this bold-only line is a section heading. */
export function headingProbability(ctx: BoldLineContext): number {
  if (!WEIGHTS_VALID) return NaN;
  const x = boldHeadingFeatures(ctx);
  let z = 0;
  for (let i = 0; i < x.length; i++) z += x[i]! * MODEL.weights[i]!;
  return sigmoid(z);
}

export function isHeadingByModel(ctx: BoldLineContext): boolean | null {
  const p = headingProbability(ctx);
  return Number.isNaN(p) ? null : p >= MODEL.threshold;
}

/** Per-feature contributions, largest magnitude first — for diagnostics and debugging. */
export function explain(ctx: BoldLineContext): Array<{ feature: string; value: number; contribution: number }> {
  const x = boldHeadingFeatures(ctx);
  return FEATURE_NAMES.map((feature, i) => ({
    feature,
    value: x[i]!,
    contribution: x[i]! * (MODEL.weights[i] ?? 0),
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/**
 * Does the hand-written rule's core signal — ASCII title-casing — even apply to
 * this text? It does not for Chinese, Japanese, Korean, Arabic or Cyrillic (no
 * ASCII letters), nor for accented Latin, where sentence-cased titles are the
 * convention. Punctuation is ignored, so an em-dash in an otherwise English
 * line does not misroute it.
 */
export function ruleSignalApplies(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return /[A-Za-z]/.test(letters) && !/[^\u0000-\u007F]/u.test(letters);
}

export const MODEL_INFO = {
  name: MODEL.model,
  kind: MODEL.kind,
  threshold: MODEL.threshold,
  valid: WEIGHTS_VALID,
};
