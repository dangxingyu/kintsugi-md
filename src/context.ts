/**
 * Parser context and the document-level signals the heuristics consult.
 *
 * Some decisions cannot be made from one line alone. Whether a dash line is a
 * setext underline or a rule depends on whether the document uses ATX headings
 * everywhere else; whether an escaped `1\.` is a list marker depends on
 * whether the surrounding document is markdown at all. Those signals are
 * computed once, up front, and carried here.
 */
import type { Line } from './preprocess.js';
import { indentOf, isBlank } from './preprocess.js';
import type { DiagnosticBag, ParseOptions } from './types.js';
import type { FenceOpen } from './scanners.js';
import { matchBareFence, matchFenceOpen } from './scanners.js';

export interface LinkRef {
  url: string;
  title: string | null;
}

export interface Ctx {
  diag: DiagnosticBag;
  options: Required<ParseOptions>;
  /** Link reference definitions, keyed by normalized label. */
  refs: Map<string, LinkRef>;
  /** Source line numbers occupied by reference definitions (skipped as blocks). */
  refLines: Set<number>;
  /**
   * True when the document clearly uses ATX (`## Heading`) style. In such a
   * document a dash line is a divider, not a setext underline — nobody mixes
   * both conventions, but LLMs emit `---` separators constantly.
   */
  prefersThematicBreak: boolean;
  /**
   * True when the document uses markdown structure elsewhere (headings,
   * fences, tables). Escaping is a deliberate act, so `1\.` only becomes a
   * list in a document that is evidently markdown to begin with.
   */
  richDocument: boolean;
  /** Current container nesting depth, capped so pathological input is safe. */
  depth: number;
  /**
   * Line numbers of every `</tag>` in the WHOLE document, by tag.
   *
   * Keyed off the document rather than the line array being parsed: block
   * parsing recurses on sliced arrays (a list item, a blockquote), and an HTML
   * closer for a tag opened inside a list item routinely sits outside it. An
   * index scoped to the slice cannot see that closer and force-closes the tag —
   * the exact bug this whole cluster was about, reintroduced one level down.
   */
  htmlClosers: Map<string, number[]>;
  /** Footnote labels in first-use order; the index is the visible marker. */
  footnoteOrder: string[];
  /** `[^label]: text` definitions found anywhere in the document. */
  footnoteDefs: Map<string, string>;
  /** label -> 1-based display index, mirroring footnoteOrder. */
  footnoteIndex: Map<string, number>;
}

/** Register a footnote reference, returning its 1-based display index. */
export function useFootnote(ctx: Ctx, label: string): number {
  // Index kept alongside the order array so a document with N distinct
  // footnotes stays O(N) rather than rescanning the array per reference.
  const existing = ctx.footnoteIndex.get(label);
  if (existing !== undefined) return existing;
  ctx.footnoteOrder.push(label);
  const n = ctx.footnoteOrder.length;
  ctx.footnoteIndex.set(label, n);
  return n;
}

/** Containers deeper than this are flattened; no real document nests this far. */
export const MAX_NESTING = 64;

/** Does the document use markdown structure beyond plain paragraphs? */
export function detectRichDocument(lines: Line[]): boolean {
  let signals = 0;
  for (const line of lines) {
    // Only the head of a line can carry a block marker, and the inline checks
    // below scan — so bound the slice. A pathologically long line would
    // otherwise make this pass quadratic.
    const t = line.text.length > 400 ? line.text.slice(0, 400) : line.text;
    if (/^ {0,3}#{1,6} +\S/.test(t)) signals += 2;
    else if (/^ {0,3}(`{3,}|~{3,})/.test(t)) signals += 2;
    else if (/^ {0,3}\|.*\|/.test(t)) signals++;
    else if (/^ {0,3}[-*+] +\S/.test(t)) signals++;
    else if (/^ {0,3}> +\S/.test(t)) signals++;
    else if (/\*\*\S|\[[^\]]+\]\(/.test(t)) signals++;
    if (signals >= 3) return true;
  }
  return false;
}

/** Index every `</tag>` in the document by tag, in source-line order. */
export function indexHtmlClosers(lines: Line[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const re = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text)) !== null) {
      const tag = m[1]!.toLowerCase();
      const list = index.get(tag);
      if (list === undefined) index.set(tag, [line.lineNo]);
      else list.push(line.lineNo);
    }
  }
  return index;
}

/** Does this document use ATX headings as its heading convention? */
export function detectAtxStyle(lines: Line[]): boolean {
  let atx = 0;
  let inFence: FenceOpen | null = null;
  for (const line of lines) {
    if (inFence) {
      const bare = matchBareFence(line.text);
      if (bare && bare.char === inFence.char && bare.len >= inFence.len) inFence = null;
      continue;
    }
    const open = matchFenceOpen(line.text);
    if (open) {
      inFence = open;
      continue;
    }
    if (/^ {0,3}#{1,6} +\S/.test(line.text)) atx++;
  }
  return atx >= 2;
}

/**
 * Pre-scan for link reference definitions (`[label]: url "title"`).
 * Done as a separate pass so forward references resolve — LLMs frequently put
 * the definition block at the very end of a long document.
 */
export function collectRefs(lines: Line[], ctx: Ctx): Set<number> {
  const consumed = new Set<number>();
  let inFence: FenceOpen | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;

    if (inFence) {
      const bare = matchBareFence(text);
      if (bare && bare.char === inFence.char && bare.len >= inFence.len) {
        inFence = null;
        continue;
      }
      // A definition block the model accidentally fenced still defines links.
      // Only for untagged fences: inside ```js, `[x]: y` is code.
      if (inFence.info === '') {
        const stranded = /^ {0,3}\[([^\]]{1,400})\]:[ \t]*(\S+)[ \t]*$/.exec(text);
        if (stranded) {
          const label = stranded[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
          if (label !== '' && !label.startsWith('^') && !ctx.refs.has(label)) {
            ctx.refs.set(label, { url: stranded[2]!, title: null });
            ctx.diag.note('extension-syntax', `Link definition "[${stranded[1]!.trim()}]" was stranded inside a code fence; still used it`, lines[i]!.lineNo);
          }
        }
      }
      continue;
    }
    const open = matchFenceOpen(text);
    if (open) {
      inFence = open;
      continue;
    }
    if (indentOf(text) >= 4) continue;

    // Footnote definition: `[^1]: text`
    const fn = /^ {0,3}\[\^([^\]\s]{1,100})\]:[ \t]*(.*)$/.exec(text);
    if (fn) {
      const label = fn[1]!;
      let body = fn[2]!;
      // Absorb indented continuation lines.
      let k = i + 1;
      while (k < lines.length && !isBlank(lines[k]!.text) && indentOf(lines[k]!.text) >= 2) {
        body += ' ' + lines[k]!.text.trim();
        consumed.add(lines[k]!.lineNo);
        k++;
      }
      const text = body.trim();
      const prior = ctx.footnoteDefs.get(label);
      if (prior === undefined) {
        ctx.footnoteDefs.set(label, text);
      } else if (prior !== text) {
        // A model re-emitting a footnote — often a correction — is exactly the
        // slip this parser exists for. Keep both bodies rather than silently
        // dropping one, and say so.
        ctx.footnoteDefs.set(label, `${prior} ${text}`);
        ctx.diag.note('extension-syntax', `Footnote [^${label}] was defined more than once; kept both definitions`, lines[i]!.lineNo);
      }
      consumed.add(lines[i]!.lineNo);
      i = k - 1;
      continue;
    }

    const m = /^ {0,3}\[([^\]]{1,400})\]:[ \t]*(\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/.exec(text);
    if (!m) continue;
    const label = m[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
    if (label === '') continue;
    let url = m[2]!;
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
    const title = m[3] ?? m[4] ?? m[5] ?? null;
    if (!ctx.refs.has(label)) ctx.refs.set(label, { url, title });
    consumed.add(lines[i]!.lineNo);
  }
  return consumed;
}

// ---------------------------------------------------------------------------
// Line classifiers
// ---------------------------------------------------------------------------
