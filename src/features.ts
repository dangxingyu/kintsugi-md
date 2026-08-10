/**
 * Features for the bold-line-as-heading decision.
 *
 * The question: a paragraph that is nothing but one bold span — is it a section
 * header the model wrote without using `#`, or is it emphasised prose?
 *
 * The hand-written rule this replaces keyed on English title-casing, which is
 * meaningless in Chinese, Japanese, Korean and Arabic (no letter case) and
 * wrong in German and French (lowercase particles). So the features here are
 * chosen to carry signal across scripts, and the case-based ones are paired
 * with an "is this even a cased script" indicator so the model can learn to
 * ignore them where they mean nothing.
 *
 * This module is imported by BOTH the training script and the parser, so the
 * features seen at fit time and at inference time cannot drift apart.
 */

export interface BoldLineContext {
  /** Inner text with the bold delimiters stripped. */
  text: string;
  /** The delimiter run that wrapped it. */
  delimiter: '**' | '__' | '***';
  /** True when the document uses `#` headings elsewhere. */
  docUsesAtx: boolean;
  /** How many other bold-only lines the document contains. */
  siblingBoldLines: number;
  /** True when a blank line follows. */
  followedByBlank: boolean;
  /** True when the next non-blank line starts a paragraph (not a list/table). */
  followedByParagraph: boolean;
  /** 0..1 position of the line within the document. */
  relativePosition: number;
}

/**
 * Sentence-terminal punctuation across scripts. This is the single most
 * portable signal we have: sentences end, titles do not. Covers Latin, CJK
 * fullwidth, Arabic, Devanagari, Armenian, Ethiopic and Greek question marks.
 */
const TERMINAL_PUNCT = /[.!?。．！？…‥؟۔।॥։՞;՜﹒｡]\s*$/u;

/** Clause-internal punctuation — a title rarely needs it, a sentence often does. */
const CLAUSE_PUNCT = /[,;，、；:：—–(){}[\]"'“”„«»]/u;

/** Trailing colon, which in every script we handle reads as "label follows". */
const TRAILING_COLON = /[:：]\s*$/u;

/**
 * Leading enumeration: "2.", "Section 2", "第二节", "III.", "(3)", "Часть 2".
 * Deliberately shape-based rather than a keyword list, so it is not English-only.
 */
const LEADING_ENUM = /^\s*(?:[0-9]+[.)、．]|[0-9]+\s|[IVXLCDM]+[.)]|[一二三四五六七八九十百千]+[、.)]|第\s*[0-9一二三四五六七八九十百千]+\s*[章节節部篇课課])/u;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const CASED_SCRIPT = /[a-zA-ZÀ-ɏͰ-ϿЀ-ӿ]/u;
const UPPERCASE = /[A-ZÀ-ÞΑ-ΩА-Я]/u;
const LOWERCASE = /[a-zß-ÿα-ωа-я]/u;

/** Words a Latin title leaves lowercase; used only when the script has case. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or',
  'per', 'the', 'to', 'via', 'vs', 'with',
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'von', 'zu', 'im', 'am',
  'de', 'du', 'la', 'le', 'les', 'des', 'et', 'ou', 'en', 'aux',
  'el', 'los', 'las', 'y', 'o', 'del', 'por', 'para',
  'и', 'в', 'на', 'с', 'по', 'из', 'для', 'к', 'о',
]);

/**
 * Estimate word count in a script-aware way. Whitespace tokenisation reports 1
 * for any Chinese line, which would make every CJK heading look "short" and
 * every CJK sentence look "short" too — no signal at all. CJK characters are
 * counted as roughly half a word each, which is the usual rule of thumb.
 */
function estimateWords(s: string): number {
  const cjkChars = (s.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/gu) ?? []).length;
  const rest = s.replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/gu, ' ');
  const latinWords = rest.split(/\s+/).filter((w) => /\S/.test(w)).length;
  return latinWords + cjkChars * 0.5;
}

function ratio(s: string, re: RegExp): number {
  if (s.length === 0) return 0;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return (s.match(g) ?? []).length / s.length;
}

/** Title-cased in a cased script. Returns 0 when the script has no case. */
function titleCaseScore(s: string): number {
  if (!CASED_SCRIPT.test(s)) return 0;
  const words = s.split(/\s+/).filter((w) => CASED_SCRIPT.test(w));
  if (words.length === 0) return 0;
  const significant = words.filter((w) => w.length >= 3 && !SMALL_WORDS.has(w.toLowerCase()));
  if (significant.length === 0) return 0;
  const capitalised = significant.filter((w) => UPPERCASE.test(w[0] ?? '')).length;
  return capitalised / significant.length;
}

/**
 * Feature names, in the order `boldHeadingFeatures` emits them. Exported so the
 * trained weights can be printed alongside the feature they belong to — a
 * hand-written rule's conditions are readable, and the replacement should be
 * readable too.
 *
 * TEXT-INTRINSIC ONLY, and that restriction is load-bearing. Supervision comes
 * from real `#` headings, but at inference time we are looking at a `**bold**`
 * line. The *text* of a title reads the same either way, so those features
 * transfer. The surrounding context does not: a `#` heading in a README sits in
 * a document full of other `#` headings, which a bold line by definition does
 * not. Training on context features taught the model about READMEs rather than
 * about titles, and it scored every genuine heading below threshold once that
 * context was absent. They are computed and available on the context object for
 * rules to use, but they are deliberately kept out of the model.
 */
export const FEATURE_NAMES = [
  'bias',
  'ends_terminal_punct',
  'ends_colon',
  'has_clause_punct',
  'leading_enumeration',
  'words_norm',
  'chars_norm',
  'is_very_short',
  'digit_ratio',
  'uppercase_ratio',
  'is_all_caps',
  'is_cased_script',
  'title_case_score',
  'cjk_ratio',
  'triple_delimiter',
] as const;

export type FeatureVector = number[];

/** Extract the feature vector. Order must match FEATURE_NAMES exactly. */
export function boldHeadingFeatures(ctx: BoldLineContext): FeatureVector {
  const t = ctx.text.trim();
  const words = estimateWords(t);
  const cased = CASED_SCRIPT.test(t);
  const letters = (t.match(new RegExp(CASED_SCRIPT.source, 'gu')) ?? []).length;
  const upper = (t.match(new RegExp(UPPERCASE.source, 'gu')) ?? []).length;
  const lower = (t.match(new RegExp(LOWERCASE.source, 'gu')) ?? []).length;

  return [
    1, // bias
    TERMINAL_PUNCT.test(t) ? 1 : 0,
    TRAILING_COLON.test(t) ? 1 : 0,
    CLAUSE_PUNCT.test(t) ? 1 : 0,
    LEADING_ENUM.test(t) ? 1 : 0,
    Math.min(words, 20) / 20,
    Math.min(t.length, 100) / 100,
    words <= 4 ? 1 : 0,
    ratio(t, /[0-9]/u),
    letters > 0 ? upper / letters : 0,
    cased && lower === 0 && upper > 0 ? 1 : 0,
    cased ? 1 : 0,
    titleCaseScore(t),
    ratio(t, CJK),
    ctx.delimiter === '***' ? 1 : 0,
  ];
}
