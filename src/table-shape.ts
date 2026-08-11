import type { Align } from './types.js';

/**
 * Table-shape detection helpers. The block parser decides when a run of lines
 * IS a table; these helpers answer the local questions:
 *  - is this line a separator row (incl. nonstandard dash variants)?
 *  - split a row into cells, respecting \| escapes and pipes in code spans
 *  - does this line plausibly look like a data row?
 */

/** Dash-ish and pipe-ish characters LLMs substitute for the ASCII ones. */
const DASH_CHARS = '\\-–—─━═~_=';
const PIPE_LOOKALIKES = /[｜│┃‖¦|┆┊╎▏]/g;
const BOX_JUNCTIONS = /[┼┬┴├┤╀╁╂╃╄╅╆╇╈╉╊╋╪╫]/g;
const BOX_CORNERS = /[┌┐└┘╭╮╯╰╔╗╚╝╒╕╘╛╓╖╙╜]/g;
/** `+---+---+` ASCII borders — matched whole-line so "a + b" is never touched. */
const ASCII_BORDER = /^\+[-+=\s]*\+$/;

const SEPARATOR_CELL = new RegExp(`^:?[${DASH_CHARS}]*:?[${DASH_CHARS}]*:?$`);
const STANDARD_SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Normalize unicode table drawing into ASCII pipes so box-drawing and
 * fullwidth-pipe tables parse like ordinary ones.
 *
 * A line uses exactly one delimiter character, and ASCII `|` wins whenever it
 * is present. `｜` and `│` are ordinary punctuation in Chinese and Japanese
 * ("清醒FM｜Gen Z 迷茫图鉴") and decoration in link lists ("[A](x) │ [B](y)"),
 * so promoting them to delimiters inside a row that already has real pipes
 * splits cells the author never split — which then cascades into a widened
 * table, a padded separator and a ragged final row. Only a line with no ASCII
 * pipe at all can be delimited by a lookalike.
 */
export function normalizePipes(text: string): string {
  const out = text.includes('|')
    ? text
    : text.replace(PIPE_LOOKALIKES, '|').replace(BOX_JUNCTIONS, '|').replace(BOX_CORNERS, '|');
  // Only a whole-line `+---+---+` border counts; a lone `+` is arithmetic.
  return ASCII_BORDER.test(out.trim()) ? out.replace(/\+/g, '|') : out;
}

/** Is this line a pure ASCII/box table border (`+---+---+`, `├───┼───┤`)? */
export function isTableBorderLine(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (ASCII_BORDER.test(t) && t.includes('-')) return true;
  return /^[┌┐└┘├┤┬┴┼╭╮╯╰─━═╔╗╚╝╠╣╦╩╬║│\s]+$/.test(t) && /[─━═]/.test(t);
}

export function hasPipeLookalike(text: string): boolean {
  PIPE_LOOKALIKES.lastIndex = 0;
  BOX_JUNCTIONS.lastIndex = 0;
  BOX_CORNERS.lastIndex = 0;
  return /[｜│┃‖¦┆┊╎▏┼┬┴├┤┌┐└┘╭╮╯╰╔╗╚╝]/.test(text);
}

export interface SeparatorInfo {
  align: Align[];
  /** True when the separator used nonstandard chars (en/em-dash, =, box art). */
  nonstandard: boolean;
}

/**
 * Parse a line as a table separator row (`| --- | :---: |`).
 * Returns null if the line is not a separator.
 */
export function parseSeparatorRow(text: string): SeparatorInfo | null {
  const raw = text.trim();
  if (raw === '') return null;
  const normalized = normalizePipes(raw);
  const nonstandardChars = normalized !== raw;
  if (!normalized.includes('|')) return null;
  if (!new RegExp(`^[|:${DASH_CHARS}\\s]+$`).test(normalized)) return null;

  const cells = splitRow(normalized);
  if (cells.length === 0) return null;

  let nonstandard = nonstandardChars;
  const align: Align[] = [];
  for (const cell of cells) {
    // Interior spaces are noise: `| :--- - |` still means left-aligned.
    const c = cell.trim().replace(/\s+/g, '');
    if (c === '') return null;
    if (!SEPARATOR_CELL.test(c)) return null;
    if (!/[-–—─━═=~_]/.test(c) && c !== '::' && c !== ':') return null;
    if (!STANDARD_SEPARATOR_CELL.test(c)) nonstandard = true;
    // `::`, `:-:` and even `-:-` all mean centered.
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    const interior = c.length > 2 && c.slice(1, -1).includes(':');
    align.push(
      (left && right) || interior || c === '::' ? 'center' : right ? 'right' : left ? 'left' : null,
    );
  }
  return { align, nonstandard };
}

/**
 * Split a table row into trimmed cell strings. Handles:
 *  - optional leading/trailing pipes
 *  - `\|` escapes (kept as literal `|` in the cell)
 *  - pipes inside inline code spans (`a | b`) staying in their cell
 */
export function splitRow(text: string): string[] {
  const s = normalizePipes(text.trim());
  const cells: string[] = [];
  let cur = '';
  let i = 0;

  // Skip a single leading pipe.
  if (s.startsWith('|')) i = 1;

  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '`') {
      // Code span: find a matching backtick run; pipes inside stay literal.
      let runLen = 1;
      while (i + runLen < s.length && s[i + runLen] === '`') runLen++;
      const closer = '`'.repeat(runLen);
      const end = s.indexOf(closer, i + runLen);
      if (end !== -1) {
        // GFM unescapes `\|` inside table cells even within a code span.
        cur += s.slice(i, end + runLen).replace(/\\\|/g, '|');
        i = end + runLen;
        continue;
      }
      cur += s.slice(i, i + runLen);
      i += runLen;
      continue;
    }
    if (ch === '$') {
      // Inline math: `$P(A|B)$` is one cell, not two. Two currency amounts in
      // one row (`| $10 | $100 |`) must NOT be joined, so the span only counts
      // as math when it carries a TeX marker rather than looking like money.
      const end = s.indexOf('$', i + 1);
      const inner = end === -1 ? '' : s.slice(i + 1, end);
      const isMath = inner !== '' && !inner.includes('$') && /[\\^_{}]|[a-zA-Z]\(/.test(inner);
      if (end !== -1 && isMath) {
        cur += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }

  // Trailing pipe produces an empty trailing cell — drop it.
  if (!(s.endsWith('|') && !s.endsWith('\\|') && cur.trim() === '')) {
    cells.push(cur.trim());
  }
  return cells;
}

/** Count pipes that act as cell delimiters (unescaped, outside code spans). */
export function delimiterPipeCount(text: string): number {
  const s = normalizePipes(text.trim());
  let count = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let runLen = 1;
      while (i + runLen < s.length && s[i + runLen] === '`') runLen++;
      const closer = '`'.repeat(runLen);
      const end = s.indexOf(closer, i + runLen);
      if (end !== -1) {
        i = end + runLen;
        continue;
      }
      i += runLen;
      continue;
    }
    if (ch === '|') count++;
    i++;
  }
  return count;
}

/**
 * Would this line plausibly be a data row of a table? Used for the
 * missing-separator heuristic, so it must demand strong evidence:
 * either the line is pipe-framed (starts with |) or it has at least two
 * delimiter pipes (i.e. at least three cells' worth of structure).
 */
export function isStrongRowCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const pipes = delimiterPipeCount(trimmed);
  if (pipes === 0) return false;
  if (trimmed.startsWith('|')) return true;
  return pipes >= 2;
}

/** Any line with at least one delimiter pipe — valid as a row once a table is established. */
export function isWeakRowCandidate(text: string): boolean {
  return delimiterPipeCount(text.trim()) > 0;
}

/**
 * An RST/terminal-style underline: two or more dash runs separated by gaps
 * (`-------     ------------------`). The gaps give the column boundaries, so
 * unlike whitespace-aligned text alone this is unambiguous evidence of a table.
 */
export function parseDashUnderline(text: string): Array<[number, number]> | null {
  if (!/^ {0,3}-{2,}(?: +-{2,})+ *$/.test(text)) return null;
  const spans: Array<[number, number]> = [];
  const re = /-{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans.length >= 2 ? spans : null;
}

/** Split a line on the column spans of a dash underline. */
export function splitBySpans(text: string, spans: Array<[number, number]>): string[] {
  const cells: string[] = [];
  for (let i = 0; i < spans.length; i++) {
    const start = i === 0 ? 0 : spans[i]![0];
    const end = i === spans.length - 1 ? text.length : spans[i + 1]![0];
    cells.push(text.slice(start, end).trim());
  }
  return cells;
}
