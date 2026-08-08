/**
 * Line classifiers.
 *
 * Everything here answers one question about one line (or a short lookahead)
 * with no parser state involved: is this a fence opener, a heading, a rule, an
 * HTML block start, leaked scaffolding? Keeping them pure makes them cheap to
 * reason about and lets both the block parser and the document-level detectors
 * share the same definitions.
 */
import type { Line } from './preprocess.js';
import { indentOf } from './preprocess.js';

export const MD_FENCE_LANGS = new Set(['markdown', 'md', 'mdx', 'gfm', 'commonmark']);

/** Apostrophe fences are not CommonMark, but models emit ''' from Python habit. */
export type FenceChar = '`' | '~' | "'";

export interface FenceOpen {
  indent: number;
  char: FenceChar;
  len: number;
  info: string;
}

export function matchFenceOpen(text: string): FenceOpen | null {
  const m = /^( {0,3})(`{3,}|~{3,}|'{3,})[ \t]*(.*)$/.exec(text);
  if (!m) return null;
  const marker = m[2]!;
  const info = m[3]!.trim();
  const char = marker[0] as FenceChar;
  // Spec: info string of a backtick fence cannot contain backticks
  // (otherwise ``` `code` ``` style inline code would be misread).
  if (char === '`' && info.includes('`')) return null;
  return { indent: m[1]!.length, char, len: marker.length, info };
}

/** A line that is nothing but a fence marker (candidate closer). */
export function matchBareFence(text: string): { char: FenceChar; len: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,}|'{3,})[ \t]*$/.exec(text);
  if (!m) return null;
  const marker = m[1]!;
  return { char: marker[0] as FenceChar, len: marker.length };
}

/** Any fence-ish line, including a short (2-char) run or one carrying text. */
export function matchFenceLine(text: string): { char: FenceChar; len: number; info: string } | null {
  const m = /^ {0,3}(`{2,}|~{2,}|'{3,})[ \t]*(.*)$/.exec(text);
  if (!m) return null;
  const marker = m[1]!;
  return { char: marker[0] as FenceChar, len: marker.length, info: m[2]!.trim() };
}

export function hasMatchingCloser(lines: Line[], start: number, fence: FenceOpen): boolean {
  for (let j = start + 1; j < lines.length; j++) {
    const bare = matchBareFence(lines[j]!.text);
    if (bare && bare.char === fence.char && bare.len >= fence.len) return true;
  }
  return false;
}

/** Does an info string name a language, rather than being an aside like "(end)"? */
export function looksLikeLanguage(info: string): boolean {
  return /^[a-zA-Z][\w+#.-]*$/.test(info.split(/\s+/)[0] ?? '');
}

/**
 * Rewrite only spellings that are not themselves a language tag: names
 * carrying punctuation a tag cannot contain, and pure file-extension spellings.
 *
 * Real shorthands (`sh`, `md`, `js`, `py`) are left alone — they are valid,
 * widely understood tags, and rewriting them would discard what the author
 * wrote for no benefit. The raw string is always kept in `info` either way.
 */
export const LANG_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  'objective-c': 'objectivec',
  'node.js': 'javascript',
  yml: 'yaml',
};

/**
 * Normalize an info string into a language tag. LLMs write `{.python}`,
 * `python:app/main.py`, `C++ code`, `js` — all naming one language.
 */
export function normalizeLang(info: string): string {
  if (info === '') return '';
  let first = info.split(/\s+/)[0] ?? '';
  // Pandoc/attribute style: ```{.python .numberLines}
  const attr = /^\{\s*\.?([\w+#.-]+)/.exec(info);
  if (attr) first = attr[1]!;
  // lang:path/to/file — keep only the language
  const colon = first.indexOf(':');
  if (colon > 0) first = first.slice(0, colon);
  first = first.replace(/^\./, '').toLowerCase();
  return LANG_ALIASES[first] ?? first;
}

export function matchAtxHeading(
  text: string,
): { depth: number; content: string; missingSpace: boolean; overDeep: number } | null {
  const m = /^ {0,3}(#{1,10})(.*)$/.exec(text);
  if (!m) return null;
  const hashes = m[1]!.length;
  let rest = m[2]!;
  let missingSpace = false;

  if (rest === '' || rest.startsWith(' ') || rest.startsWith('\t')) {
    rest = rest.trim();
  } else {
    // Missing space after hashes. `##Heading` is unambiguous (nobody writes a
    // hashtag with two hashes); a single `#` is only a heading when followed
    // by a letter (`#Introduction` yes, `#1 priority` / `#!/bin/sh` no).
    if (hashes >= 2 && !rest.startsWith('#')) missingSpace = true;
    else if (hashes === 1 && /^[a-zA-ZÀ-ɏ一-鿿]/.test(rest)) missingSpace = true;
    else return null;
    rest = rest.trim();
  }

  // Strip a trailing closing hash run. A preceding space is the CommonMark
  // rule, but LLMs write `##Key Findings##`, so an unspaced run is stripped
  // too when the text before it is multi-character (keeps `# C#` intact).
  const spaced = rest.replace(/[ \t]+#+[ \t]*$/, '');
  if (spaced !== rest) {
    rest = spaced.trim();
  } else {
    const glued = /^(.*[^#\s]{2,})#+$/.exec(rest);
    if (glued) rest = glued[1]!.trim();
  }
  if (rest === '' && missingSpace) return null;

  const overDeep = hashes > 6 ? hashes : 0;
  return { depth: Math.min(hashes, 6), content: rest, missingSpace, overDeep };
}

export function matchThematicBreak(text: string): { nonstandard: boolean } | null {
  const t = text.trim();
  if (text.match(/^ {4,}/)) return null;
  if (/^([-_*])( *\1){2,} *$/.test(t)) return { nonstandard: false };
  // LLM separators: em/en-dash runs, equals runs, long dash runs are standard-ish.
  if (/^[—–]{2,}$/.test(t) || /^={3,}$/.test(t)) return { nonstandard: true };
  return null;
}

export const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'audio', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html',
  'iframe', 'img', 'input', 'legend', 'li', 'link', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option',
  'p', 'picture', 'pre', 'script', 'section', 'select', 'source', 'style', 'summary', 'table', 'tbody',
  'td', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'video',
]);

export const RAW_TEXT_TAGS = new Set(['script', 'style', 'pre', 'textarea']);

export function matchHtmlBlockStart(text: string): { tag: string; rawText: boolean; comment: boolean } | null {
  const t = text.trimStart();
  if (indentOf(text) >= 4) return null;
  if (t.startsWith('<!--')) return { tag: '', rawText: false, comment: true };
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(t);
  if (!m) return null;
  const tag = m[2]!.toLowerCase();
  // Deliberate deviation from CommonMark type-7: unknown/pseudo tags
  // (<thinking>, <output>, <Result>…) are NOT HTML blocks — they stay text so
  // the reader can see them.
  if (!HTML_BLOCK_TAGS.has(tag)) return null;
  return { tag, rawText: m[1] === '' && RAW_TEXT_TAGS.has(tag), comment: false };
}

/** LaTeX environments LLMs emit bare, with no $$ or \[ wrapper around them. */
export const MATH_ENVIRONMENTS =
  /^ {0,3}\\begin\{(align\*?|equation\*?|gather\*?|multline\*?|split|aligned|cases|array|matrix|[bBpvV]matrix|eqnarray\*?)\}/;

/** Pseudo-tags models use for their own reasoning, never part of a document. */
export const SCAFFOLDING_TAGS = new Set([
  'thinking', 'think', 'thought', 'thoughts', 'reasoning', 'reflection', 'scratchpad',
  'scratch_pad', 'internal', 'inner_monologue', 'analysis', 'plan', 'planning',
  'antthinking', 'system', 'output', 'answer', 'response', 'final_answer',
]);

/** Chat-template control tokens: `<|im_end|>`, `<|endoftext|>`, `<|eot_id|>`. */
export const CONTROL_TOKEN_LINE = /^(?:\s*(?:<\|[\w|.-]*\|>|<\/?[a-zA-Z][\w-]*>))+\s*$/;

/** Line indices of every `</tag>` closer, by tag, memoized per document. */
const scaffoldCloserCache = new WeakMap<Line[], Map<string, number[]>>();
function scaffoldClosers(lines: Line[]): Map<string, number[]> {
  let found = scaffoldCloserCache.get(lines);
  if (found === undefined) {
    found = new Map<string, number[]>();
    for (let k = 0; k < lines.length; k++) {
      const m = /^<\/([a-zA-Z][\w-]*)\s*>$/.exec(lines[k]!.text.trim());
      if (!m) continue;
      const tag = m[1]!.toLowerCase();
      if (!SCAFFOLDING_TAGS.has(tag)) continue;
      const list = found.get(tag);
      if (list === undefined) found.set(tag, [k]);
      else list.push(k);
    }
    scaffoldCloserCache.set(lines, found);
  }
  return found;
}

/**
 * Detect leaked scaffolding at `start`. Returns the exclusive end line, or
 * null. Only whole-line matches count, so a `<thinking>` mentioned inside a
 * sentence or a code fence is untouched.
 */
export function matchScaffolding(lines: Line[], start: number): { kind: string; end: number } | null {
  const t = lines[start]!.text.trim();

  // `<thinking>` … `</thinking>` on their own lines.
  const open = /^<([a-zA-Z][\w-]*)>$/.exec(t);
  if (open && SCAFFOLDING_TAGS.has(open[1]!.toLowerCase())) {
    const tag = open[1]!.toLowerCase();
    const closers = scaffoldClosers(lines).get(tag);
    if (closers === undefined) return null; // never closed — leave as content
    // Binary search for the first closer after `start`. Scanning forward here
    // instead would rescan to end of input for every unmatched opener, which a
    // document full of leaked `<thinking>` markers turns into O(n^2).
    let lo = 0;
    let hi = closers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (closers[mid]! > start) hi = mid;
      else lo = mid + 1;
    }
    const j = closers[lo];
    return j === undefined ? null : { kind: tag, end: j + 1 };
  }

  if (isControlTokenLine(t)) return { kind: 'control-token', end: start + 1 };
  return null;
}

/** A line made only of chat control tokens and/or stray pseudo-tag closers. */
export function isControlTokenLine(text: string): boolean {
  const t = text.trim();
  if (!t.includes('<|') || !CONTROL_TOKEN_LINE.test(t)) return false;
  const tokens = t.match(/<\|[\w|.-]*\|>|<\/?[a-zA-Z][\w-]*>/g) ?? [];
  if (tokens.length === 0) return false;
  return tokens.every((tok) => {
    if (tok.startsWith('<|')) return true;
    const name = /^<\/?([a-zA-Z][\w-]*)>$/.exec(tok)?.[1]?.toLowerCase();
    return name !== undefined && SCAFFOLDING_TAGS.has(name);
  });
}

export function matchMathBlockOpen(text: string): { delim: '$$' | '\\[' | 'env'; rest: string; env?: string } | null {
  let m = /^ {0,3}\$\$(.*)$/.exec(text);
  if (m) return { delim: '$$', rest: m[1]! };
  m = /^ {0,3}\\\[(.*)$/.exec(text);
  if (m) return { delim: '\\[', rest: m[1]! };
  const env = MATH_ENVIRONMENTS.exec(text);
  if (env) return { delim: 'env', rest: text.trim(), env: env[1]! };
  return null;
}

/** Does this line begin a construct that interrupts a paragraph? */
