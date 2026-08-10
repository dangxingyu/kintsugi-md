/**
 * The inline token model.
 *
 * Inline parsing runs in two stages: the scanner turns text into tokens
 * (literal nodes, emphasis delimiters, brackets, HTML span markers), then a
 * series of passes resolves those tokens into a tree. This module holds the
 * shape those stages agree on, plus the final assembly back into AST nodes.
 */
import type { Inline } from './types.js';

export interface NodeTok {
  kind: 'node';
  node: Inline;
}

export interface DelimTok {
  kind: 'delim';
  char: '*' | '_' | '~';
  count: number;
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
  /** Why flanking failed, for recovery: run had whitespace right after/before. */
  spaceAfter: boolean;
  spaceBefore: boolean;
  /** True when a letter or digit immediately follows the run. */
  nextIsWord: boolean;
  /** True when a digit immediately precedes the run. */
  prevIsDigit: boolean;
  /** Whitespace-delimited word immediately before the run ('' at line start). */
  prevWord: string;
  /** Whitespace-delimited word immediately after the run ('' at line end). */
  nextWord: string;
  line: number;
  /** Scan-order id, stable across array splices (used by openersBottom). */
  seq: number;
}

export interface BracketTok {
  kind: 'bracket';
  image: boolean;
  active: boolean;
  line: number;
}

/** `<b>` / `</b>`-style markers for HTML tags we map onto native nodes. */
export interface HtmlSpanTok {
  kind: 'htmlSpan';
  closing: boolean;
  tag: string;
  node: 'strong' | 'emphasis' | 'delete';
  raw: string;
  /** Set once the marker has been folded into a node. */
  used: boolean;
  line: number;
}

export type Tok = NodeTok | DelimTok | BracketTok | HtmlSpanTok;



export const text = (value: string): NodeTok => ({ kind: 'node', node: { type: 'text', value } });

export const isWs = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
/**
 * Punctuation for CommonMark's flanking rules — Unicode-wide, not ASCII.
 *
 * The ASCII-only version cost dearly on real documents: a closing `**`
 * followed by 。 or ， failed the right-flanking test, the pair never matched,
 * and the "unclosed emphasis" recovery then bolted the rest of the line into
 * <strong>. An audit measured 1,284 such firings on 3,090 READMEs — all false,
 * concentrated in Chinese and Japanese text. \p{P} and \p{S} match what the
 * CommonMark spec actually says (Unicode punctuation and symbols).
 */
export const isPunct = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{P}\p{S}]/u.test(ch);

export function isBreakTok(t: Tok): boolean {
  return t.kind === 'node' && (t.node.type === 'softBreak' || t.node.type === 'hardBreak');
}

export function trimEdgeSpaces(toks: Tok[]): void {
  const first = toks[0];
  if (first !== undefined && first.kind === 'node' && first.node.type === 'text') {
    first.node.value = first.node.value.replace(/^\s+/, '');
  }
  const last = toks[toks.length - 1];
  if (last !== undefined && last.kind === 'node' && last.node.type === 'text') {
    last.node.value = last.node.value.replace(/\s+$/, '');
  }
}

/**
 * Flatten tokens from `from` onward into plain text, stopping at `maxLen`.
 *
 * Takes a start index rather than a pre-sliced array on purpose: slicing is
 * O(n) per call, and this runs once per `]`, which made deeply bracketed input
 * quadratic.
 */
export function plainTextOf(toks: Tok[], from = 0, maxLen = Infinity): string {
  let out = '';
  for (let i = from; i < toks.length; i++) {
    const t = toks[i]!;
    if (out.length >= maxLen) break;
    if (t.kind === 'node') {
      if (t.node.type === 'text' || t.node.type === 'inlineCode') out += t.node.value;
      else if ('children' in t.node) out += inlinePlainText(t.node.children as Inline[]);
    } else if (t.kind === 'delim') {
      out += t.char.repeat(t.count);
    }
  }
  return out;
}

export function inlinePlainText(nodes: Inline[], depth = 0): string {
  // Depth-bounded for the same reason the fold above is: an alt string is
  // computed by walking the whole subtree, and the subtree may be adversarial.
  if (depth > 64) return '';
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'inlineMath':
        out += node.value;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'softBreak':
      case 'hardBreak':
        out += ' ';
        break;
      default:
        if ('children' in node) out += inlinePlainText(node.children, depth + 1);
    }
  }
  return out;
}

export function assemble(toks: Tok[]): Inline[] {
  const out: Inline[] = [];
  const push = (node: Inline) => {
    const last = out[out.length - 1];
    if (node.type === 'text' && last !== undefined && last.type === 'text') {
      last.value += node.value;
      return;
    }
    out.push(node);
  };

  for (const t of toks) {
    if (t.kind === 'node') push(t.node);
    else if (t.kind === 'delim') {
      if (t.count > 0) push({ type: 'text', value: t.char.repeat(t.count) });
    } else if (t.kind === 'htmlSpan') {
      // Never paired up: fall back to the raw tag, as before.
      push({ type: 'htmlInline', value: t.raw });
    } else {
      push({ type: 'text', value: t.image ? '![' : '[' });
    }
  }

  // Drop leading/trailing breaks and trim outer whitespace.
  while (out.length > 0 && (out[0]!.type === 'softBreak' || out[0]!.type === 'hardBreak')) out.shift();
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.type === 'softBreak' || last.type === 'hardBreak') {
      out.pop();
      continue;
    }
    break;
  }
  const first = out[0];
  if (first !== undefined && first.type === 'text') first.value = first.value.replace(/^\s+/, '');
  const lastNode = out[out.length - 1];
  if (lastNode !== undefined && lastNode.type === 'text') lastNode.value = lastNode.value.replace(/\s+$/, '');
  return out.filter((n) => !(n.type === 'text' && n.value === ''));
}


// Re-export used by block parser for link text extraction.
