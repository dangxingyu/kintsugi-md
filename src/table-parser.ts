/**
 * GFM tables, and the many ways a model gets them wrong.
 *
 * A table is the construct LLMs break most destructively: strict GFM refuses to
 * render one whose separator row is missing or miscounted, and silently drops
 * cells from rows that are too long. Here a missing separator is inferred, a
 * ragged row is merged into the column its shape fits rather than truncated,
 * and glued or re-emitted tables are split apart.
 */
import type { Align, Block, Table, TableRow } from './types.js';
import type { Line } from './preprocess.js';
import { indentOf, isBlank } from './preprocess.js';
import type { Ctx } from './context.js';
import { parseInlines } from './inline-parser.js';
import { matchAtxHeading, matchFenceOpen } from './scanners.js';
import { startsAnyBlock } from './block-parser.js';
import {
  delimiterPipeCount,
  isStrongRowCandidate,
  isTableBorderLine,
  isWeakRowCandidate,
  parseDashUnderline,
  parseSeparatorRow,
  splitBySpans,
  splitRow,
} from './table-shape.js';

/** Columns beyond this in one row are merged; guards against pipe floods. */
const MAX_COLUMNS = 256;

export function tryConsumeTable(lines: Line[], start: number, ctx: Ctx, blocks: Block[], fromParagraph: boolean): number {
  const { diag } = ctx;
  const n = lines.length;
  const text = lines[start]!.text;
  if (indentOf(text) >= 4) return -1;

  let next = start + 1 < n ? lines[start + 1]!.text : null;

  // A box-drawing top border (`┌───┬───┐` / `+---+---+`) precedes the header.
  // A box-drawing top border sits above the header row. The next line must be
  // a real row, not another border — otherwise a run of `+---+---+` lines would
  // recurse once per line and never terminate.
  if (
    isTableBorderLine(text) &&
    next !== null &&
    isWeakRowCandidate(next) &&
    !isTableBorderLine(next) &&
    parseSeparatorRow(next) === null
  ) {
    const inner = tryConsumeTable(lines, start + 1, ctx, blocks, fromParagraph);
    if (inner !== -1) {
      diag.repair('table-nonstandard-separator', 'Box-drawing table border recognized; parsed the block as a table', lines[start]!.lineNo);
      return inner;
    }
  }

  // RST/terminal style: a header line underlined by spaced dash runs, which
  // define the column boundaries.
  if (next !== null && delimiterPipeCount(text) === 0) {
    const spans = parseDashUnderline(next);
    if (spans && text.trim() !== '' && splitBySpans(text, spans).filter((c: string) => c !== '').length >= 2) {
      const rows: TableRow[] = [];
      const mkRow = (line: Line): TableRow => ({
        type: 'tableRow',
        cells: splitBySpans(line.text, spans).map((c: string) => ({
          type: 'tableCell' as const,
          children: parseInlines(c, line.lineNo, ctx),
        })),
      });
      rows.push(mkRow(lines[start]!));
      let k = start + 2;
      for (; k < n && !isBlank(lines[k]!.text); k++) rows.push(mkRow(lines[k]!));
      diag.repair('table-nonstandard-separator', 'Dash-underlined column layout recognized as a table', lines[start + 1]!.lineNo);
      blocks.push({
        type: 'table',
        align: new Array<Align>(spans.length).fill(null),
        rows,
        headerless: false,
        pos: { startLine: lines[start]!.lineNo, endLine: lines[k - 1]!.lineNo },
      });
      return k;
    }
  }

  // Case A: header + separator (standard GFM, with tolerances).
  if (next !== null && isWeakRowCandidate(text)) {
    const sep = parseSeparatorRow(next);
    if (sep) {
      return buildTable(lines, start, start + 1, sep.align, sep.nonstandard, ctx, blocks);
    }
    // Case C: bare dash line sandwiched between two pipe rows.
    if (/^ {0,3}[-=–—]{3,}\s*$/.test(next) && start + 2 < n && isWeakRowCandidate(lines[start + 2]!.text)) {
      const headerCells = splitRow(text).length;
      const bodyCells = splitRow(lines[start + 2]!.text).length;
      if (headerCells >= 2 && Math.abs(headerCells - bodyCells) <= 1) {
        diag.repair('table-nonstandard-separator', 'Bare dash line between pipe rows treated as a table separator', lines[start + 1]!.lineNo);
        return buildTable(lines, start, start + 1, new Array<Align>(headerCells).fill(null), true, ctx, blocks);
      }
    }
  }

  // A first row whose every cell is bold is the model's substitute for a
  // separator, so one pipe is enough evidence there.
  const allCellsBold = (line: string): boolean => {
    const cells = splitRow(line);
    return cells.length >= 2 && cells.every((c: string) => /^\*\*.+\*\*$/.test(c.trim()) || /^__.+__$/.test(c.trim()));
  };
  const headerish = isStrongRowCandidate(text) || allCellsBold(text);

  // Case B: missing separator — needs strong evidence: ≥2 consecutive strong
  // row candidates with compatible cell counts.
  if (!fromParagraph && next !== null && headerish && (isStrongRowCandidate(next) || delimiterPipeCount(next) >= 1)) {
    const c1 = splitRow(text).length;
    const c2 = splitRow(next).length;
    if (c1 >= 2 && c2 >= 2 && Math.abs(c1 - c2) <= 1) {
      diag.repair('table-missing-separator', 'Table had no separator row; treated the first row as the header', lines[start]!.lineNo);
      return buildTable(lines, start, -1, new Array<Align>(Math.max(c1, c2)).fill(null), false, ctx, blocks);
    }
    // Caption variant: single-cell first row above a real table.
    if (c1 === 1 && c2 >= 2 && text.trim().startsWith('|')) {
      const cap = splitRow(text)[0] ?? '';
      blocks.push({
        type: 'paragraph',
        children: parseInlines(cap, lines[start]!.lineNo, ctx),
        pos: { startLine: lines[start]!.lineNo, endLine: lines[start]!.lineNo },
      });
      diag.repair('table-missing-separator', 'Single-cell row above a table treated as a caption paragraph', lines[start]!.lineNo);
      const sub = tryConsumeTable(lines, start + 1, ctx, blocks, fromParagraph);
      return sub === -1 ? start + 1 : sub;
    }
  }

  return -1;
}

/**
 * A cell can't contain a real newline, so line breaks arrive as `<br>` or a
 * literal backslash-n. Convert both to a hard break (two spaces + newline).
 */
export function cellLineBreaks(cell: string, rowHasOpenEmphasis: boolean): string {
  let out = cell.replace(/<br\s*\/?>/gi, '  \n');

  // A cell ending in a lone `**` can be the closer of emphasis opened in an
  // earlier cell (`| **Baseline | Improved** |`). Only reopen when an earlier
  // cell in THIS row actually left one open — otherwise `99.9%**`, an asterisk
  // footnote marker, would lose its marker and get bolded instead.
  if (rowHasOpenEmphasis) {
    for (const d of ['**', '__'] as const) {
      const occurrences = out.split(d).length - 1;
      if (occurrences === 1 && out.trimEnd().endsWith(d) && out.trim() !== d) {
        out = d + out;
        break;
      }
    }
  }

  // A literal backslash-n between two pieces of text is a line break the model
  // could not write directly. A cell that IS `\n` is documenting the escape
  // sequence itself, so it stays text.
  if (out.includes('\\n') && !/`[^`]*\\n[^`]*`/.test(out) && /\S/.test(out.replace(/\\n/g, ''))) {
    out = out.replace(/(\S)\s*\\n\s*(?=\S)/g, '$1  \n');
  }
  return out;
}

/** Does any cell before `upTo` leave a `**`/`__` run unclosed? */
function rowOpensEmphasis(cells: string[], upTo: number): boolean {
  for (let i = 0; i < upTo; i++) {
    const c = cells[i] ?? '';
    for (const d of ['**', '__']) {
      if ((c.split(d).length - 1) % 2 === 1) return true;
    }
  }
  return false;
}

/** Coarse type of a table cell, used to score where a ragged row should merge. */
export function cellShape(cell: string): string {
  const c = cell.trim();
  if (c === '') return 'empty';
  if (c.includes(' | ')) return 'merged';
  if (/^`.*`$/.test(c)) return 'code';
  if (/^".*"$|^'.*'$/.test(c)) return 'quoted';
  if (/^(true|false|yes|no|n\/a|-|✓|✗)$/i.test(c)) return 'bool';
  if (/^[$€£]?[\d.,]+\s*[%a-zA-Z]{0,4}$/.test(c)) return 'num';
  if (/^[\w./@-]+$/.test(c)) return 'ident';
  return 'prose';
}

export function sameCells(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every((cell, i) => cell.trim().toLowerCase() === (b[i] ?? '').trim().toLowerCase());
}

/**
 * Build a table starting at `headerIdx`; `sepIdx === -1` means the separator
 * is missing (inferred header).
 */
export function buildTable(
  lines: Line[],
  headerIdx: number,
  sepIdx: number,
  align: Align[],
  nonstandardSep: boolean,
  ctx: Ctx,
  blocks: Block[],
): number {
  const { diag } = ctx;
  const n = lines.length;
  const headerLine = lines[headerIdx]!;
  let headerCells = splitRow(headerLine.text);
  if (headerCells.length > MAX_COLUMNS) {
    diag.note('table-ragged-row', `Header had ${headerCells.length} cells; capped the table at ${MAX_COLUMNS} columns`, headerLine.lineNo);
    headerCells = headerCells.slice(0, MAX_COLUMNS);
  }

  if (nonstandardSep && sepIdx !== -1) {
    diag.repair('table-nonstandard-separator', 'Separator row uses nonstandard characters; accepted', lines[sepIdx]!.lineNo);
  }

  // Collect body rows.
  const bodyLines: Line[] = [];
  let j = (sepIdx === -1 ? headerIdx : sepIdx) + 1;
  for (; j < n; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) break;
    if (isTableBorderLine(t)) continue; // `+---+---+` / `├───┼───┤` decoration
    // A line that reads as a sentence fragment — starting lowercase, and with
    // too few cells to be a row of its own — is a cell the model wrapped onto
    // the next line. Fold it back rather than ending the table.
    {
      const frag = t.trim();
      const prev = bodyLines[bodyLines.length - 1];
      const fragCells = splitRow(t).length;
      // A wrapped cell is a fragment: it starts mid-sentence and does not end
      // like a sentence. A full sentence under a table is a caption, and
      // folding it in would corrupt the last cell's value.
      const isSentence = /[.!?]\s*$/.test(frag) && frag.split(/\s+/).length > 5;
      if (
        prev !== undefined &&
        /^[a-z(,;)]/.test(frag) &&
        !isSentence &&
        !startsAnyBlock(t) &&
        fragCells < headerCells.length
      ) {
        diag.repair('table-merged-continuation', 'Folded a wrapped continuation line back into the previous row', lines[j]!.lineNo);
        bodyLines[bodyLines.length - 1] = { text: prev.text.replace(/\s*\|?\s*$/, '') + ' ' + frag, lineNo: prev.lineNo };
        continue;
      }
    }
    if (!isWeakRowCandidate(t)) break;
    if (matchFenceOpen(t)) break;
    const h = matchAtxHeading(t);
    if (h && !h.missingSpace) break;

    const nextText = j + 1 < n ? lines[j + 1]!.text : null;
    // A bottom/middle border of a box-drawn table also parses as a separator;
    // it does not mean a new table is starting.
    const nextIsSeparator =
      nextText !== null && parseSeparatorRow(nextText) !== null && !isTableBorderLine(nextText);

    // A row repeating the header (with or without its separator) is a
    // re-emission from a retry — drop it and keep the one table.
    if (sameCells(splitRow(t), headerCells)) {
      diag.note('table-merged-continuation', 'Dropped a repeated header row inside the table', lines[j]!.lineNo);
      if (nextIsSeparator) j++;
      continue;
    }

    // A *different* header followed by its own separator starts a new table
    // that was glued onto this one with no blank line between.
    if (nextIsSeparator) {
      diag.repair('table-merged-continuation', 'Two tables were glued together; split them at the second header', lines[j]!.lineNo);
      break;
    }

    // A stray extra separator row is decoration, not data.
    if (parseSeparatorRow(t)) continue;

    bodyLines.push(lines[j]!);
  }

  // Merged continuation: blank line(s), then more strong rows with no
  // separator of their own — a table the LLM accidentally split.
  let end = j;
  for (;;) {
    let k = end;
    while (k < n && isBlank(lines[k]!.text)) k++;
    if (k === end || k >= n) break;
    if (!isStrongRowCandidate(lines[k]!.text)) break;
    const repeatsHeader = sameCells(splitRow(lines[k]!.text), headerCells);
    if (k + 1 < n && parseSeparatorRow(lines[k + 1]!.text) && !repeatsHeader) break; // its own table
    const cont = splitRow(lines[k]!.text).length;
    if (cont !== headerCells.length && cont !== align.length) break;
    if (repeatsHeader) {
      // The model re-emitted the header (and maybe its separator) after a
      // blank line; skip both and keep appending to the same table.
      diag.note('table-merged-continuation', 'Dropped a header re-emitted after a blank line', lines[k]!.lineNo);
      k++;
      if (k < n && parseSeparatorRow(lines[k]!.text)) k++;
      if (k >= n) break;
    }
    diag.repair('table-merged-continuation', 'Rows after a blank line merged into the preceding table', lines[k]!.lineNo);
    while (k < n && !isBlank(lines[k]!.text) && isWeakRowCandidate(lines[k]!.text)) {
      bodyLines.push(lines[k]!);
      k++;
    }
    end = k;
  }

  // Determine column count: header wins unless a supermajority of body rows
  // agree on a larger count (the body outvotes a truncated header).
  const bodyCellCounts = bodyLines.map((l) => splitRow(l.text).length);
  let cols = headerCells.length;
  if (bodyCellCounts.length >= 2) {
    const countFreq = new Map<number, number>();
    for (const c of bodyCellCounts) countFreq.set(c, (countFreq.get(c) ?? 0) + 1);
    for (const [c, freq] of countFreq) {
      if (c > cols && freq >= Math.ceil(bodyCellCounts.length * 0.6)) {
        diag.repair('table-ragged-row', `Header has ${cols} cells but most rows have ${c}; widened the table to ${c} columns`, headerLine.lineNo);
        cols = c;
      }
    }
  }

  if (align.length !== cols) {
    if (sepIdx !== -1) {
      diag.repair('table-separator-mismatch', `Separator has ${align.length} cells but the table has ${cols} columns; adjusted`, lines[sepIdx]!.lineNo);
    }
    align = align.slice(0, cols);
    while (align.length < cols) align.push(null);
  }

  // Shape profile of each column, learned from the rows that are well-formed.
  const profile: Array<Set<string>> = [];
  for (const l of bodyLines) {
    const cells = splitRow(l.text);
    if (cells.length !== cols) continue;
    cells.forEach((c: string, idx: number) => {
      (profile[idx] ??= new Set()).add(cellShape(c));
    });
  }

  const makeRow = (cells: string[], lineNo: number): TableRow => {
    if (cells.length > cols) {
      // Merge the overflow, choosing WHICH cells to join by how well the
      // result fits the column shapes the clean rows established. Always
      // merging into the last cell would drop a type union into the wrong
      // column. Nothing is ever discarded.
      const span = cells.length - cols + 1;
      let best: string[] | null = null;
      let bestScore = -1;
      for (let p = 0; p + span <= cells.length; p++) {
        const candidate = [
          ...cells.slice(0, p),
          cells.slice(p, p + span).join(' | '),
          ...cells.slice(p + span),
        ];
        let score = 0;
        for (let idx = 0; idx < candidate.length; idx++) {
          if (idx === p) {
            // A prose column can absorb stray pipes; a column of identifiers
            // or numbers cannot, so merging there is almost certainly wrong.
            if (profile[idx]?.has('prose')) score++;
            continue;
          }
          if (profile[idx]?.has(cellShape(candidate[idx]!))) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      diag.repair('table-ragged-row', `Row has ${cells.length} cells, expected ${cols}; merged the overflow into one cell`, lineNo);
      cells = best ?? cells.slice(0, cols);
    } else if (cells.length < cols) {
      diag.note('table-ragged-row', `Row has ${cells.length} cells, expected ${cols}; padded with empty cells`, lineNo);
      cells = [...cells];
      while (cells.length < cols) cells.push('');
    }
    return {
      type: 'tableRow',
      cells: cells.map((c, idx) => ({
        type: 'tableCell' as const,
        children: parseInlines(cellLineBreaks(c, rowOpensEmphasis(cells, idx)), lineNo, ctx),
      })),
    };
  };

  const rows: TableRow[] = [makeRow(headerCells, headerLine.lineNo)];
  for (const l of bodyLines) rows.push(makeRow(splitRow(l.text), l.lineNo));

  const table: Table = {
    type: 'table',
    align,
    rows,
    headerless: false,
    inferredSeparator: sepIdx === -1,
    pos: { startLine: headerLine.lineNo, endLine: bodyLines.length > 0 ? bodyLines[bodyLines.length - 1]!.lineNo : headerLine.lineNo },
  };
  blocks.push(table);
  return end;
}

// ---------------------------------------------------------------------------
// Paragraphs (incl. setext handling)
// ---------------------------------------------------------------------------

/**
 * A run of config-shaped lines (`[Section]`, `key = value`) introduced by a
 * line ending in a colon. Models paste unit files, INI and .env snippets
 * without fencing them, and as prose they render as one mangled paragraph.
 * Returns the line index just past the run, or -1.
 */
