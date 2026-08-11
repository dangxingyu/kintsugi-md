/**
 * Ordered and bullet lists.
 *
 * This is where most of the tolerance lives, because list markers are what LLMs
 * get wrong most often: drifting indent widths, unicode bullets, lettered and
 * roman markers, checkboxes glued to the bullet, numbering that restarts, and
 * commands left flush-left between steps. Marker shapes that are ambiguous with
 * ordinary prose are only believed when a sibling item confirms them.
 */
import type { Block, ListItem } from './types.js';
import type { Line } from './preprocess.js';
import { indentOf, isBlank } from './preprocess.js';
import type { Ctx } from './context.js';
import { MAX_NESTING } from './context.js';
import { parseInlines } from './inline-parser.js';
import { matchBareFence, matchFenceOpen } from './scanners.js';
import type { FenceOpen } from './scanners.js';
import { parseBlocks, startsAnyBlock } from './block-parser.js';

export const UNICODE_BULLETS = new Set(['•', '●', '○', '‣', '▪', '▸', '◦', '·', '–', '—']);
/**
 * Dashes and middots are only bullets when they repeat. A lone `— Someone` is
 * an attribution line, not a one-item list; `• x` is unambiguous either way.
 */
export const AMBIGUOUS_BULLETS = new Set(['·', '–', '—']);

/** Marker shapes that need a sibling to be believed (see needsSibling). */
export type MarkerStyle =
  | 'bullet' | 'unicode-bullet' | 'ambiguous-bullet' | 'number' | 'paren-number'
  | 'alpha' | 'roman' | 'glued' | 'colon-number' | 'prose-step' | 'escaped-number';

export interface ListMarker {
  indent: number;
  ordered: boolean;
  bulletChar: string;
  num: number;
  /** Column where item content starts. */
  contentIndent: number;
  /** Rest of the line after the marker. */
  rest: string;
  style: MarkerStyle;
  unicodeBullet: boolean;
  parenNumber: boolean;
  gluedTask: boolean;
  /** Marker written without the space that separates it from the text. */
  missingSpace: boolean;
}

export const ROMAN_VALUES: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
};

export function widthOf(spaces: string): number {
  return spaces === '' ? 1 : Math.min(spaces.replace(/\t/g, '    ').length, 4);
}

export function matchListMarker(text: string): ListMarker | null {
  const base = {
    unicodeBullet: false,
    parenNumber: false,
    gluedTask: false,
    missingSpace: false,
  };

  // `-[ ] task` — checkbox glued to the bullet, no separating space.
  let m = /^( {0,5})([-*+])(\[[ xX✓✗~-]?\])[ \t]*(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    return {
      ...base, indent, ordered: false, bulletChar: m[2]!, num: 0,
      contentIndent: indent + 2, rest: m[3]! + ' ' + m[4]!,
      style: 'glued', gluedTask: true,
    };
  }

  // Bullets, including unicode ones.
  m = /^( {0,5})([-*+•●○‣▪▸◦·–—])(?:([ \t]+)(.*))?$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const ch = m[2]!;
    const spaces = m[3] ?? '';
    const rest = m[4] ?? '';
    if (spaces === '' && rest === '' && text.trim() !== ch) return null;
    return {
      ...base, indent, ordered: false, bulletChar: ch, num: 0,
      contentIndent: indent + 1 + (rest === '' ? 1 : widthOf(spaces)),
      rest,
      style: UNICODE_BULLETS.has(ch) ? (AMBIGUOUS_BULLETS.has(ch) ? 'ambiguous-bullet' : 'unicode-bullet') : 'bullet',
      unicodeBullet: UNICODE_BULLETS.has(ch),
    };
  }

  // `1.` / `1)` / `1.)`, tolerating a stray space before the dot ("1 .").
  m = /^( {0,5})(\d{1,9})[ \t]?(\.\)|[.)])(?:([ \t]+)(.*))?$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const digits = m[2]!;
    const punct = m[3]!;
    const spaces = m[4] ?? '';
    const rest = m[5] ?? '';
    if (spaces === '' && rest === '' && text.trim() !== digits + punct) return null;
    return {
      ...base, indent, ordered: true, bulletChar: punct, num: parseInt(digits, 10),
      contentIndent: indent + digits.length + punct.length + (rest === '' ? 1 : widthOf(spaces)),
      rest, style: 'number',
    };
  }

  // `1\.` — the model escaped the dot to stop *its own* renderer from making
  // a list, then pasted it where a list was wanted after all. Only believed in
  // a document that is otherwise markdown (see `escaped` handling below).
  m = /^( {0,5})(\d{1,9})\\\.([ \t]+)(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const digits = m[2]!;
    return {
      ...base, indent, ordered: true, bulletChar: '.', num: parseInt(digits, 10),
      contentIndent: indent + digits.length + 2 + widthOf(m[3]!),
      rest: m[4]!, style: 'escaped-number',
    };
  }

  // `1:` colon-style numbering, and `Step 1:` / `Step 1.` prose labels. Both
  // need a sibling run (needsSibling) so ordinary prose is never captured.
  m = /^( {0,5})(\d{1,9}):([ \t]+)(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const digits = m[2]!;
    return {
      ...base, indent, ordered: true, bulletChar: ':', num: parseInt(digits, 10),
      contentIndent: indent + digits.length + 1 + widthOf(m[3]!),
      rest: m[4]!, style: 'colon-number',
    };
  }
  // `Step 1: …` prose labels. The label stays in the item text — it is content
  // the author wrote and other prose may cross-reference it.
  m = /^( {0,5})((?:Step|STEP|Phase|Stage)[ \t]+(\d{1,3})[:.)]?)[ \t]+(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    return {
      ...base, indent, ordered: true, bulletChar: '.', num: parseInt(m[3]!, 10),
      contentIndent: indent + 2, rest: `${m[2]!} ${m[4]!}`, style: 'prose-step',
    };
  }

  // `(1)` parenthesized numbers.
  m = /^( {0,5})\((\d{1,9})\)([ \t]+)(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const digits = m[2]!;
    return {
      ...base, indent, ordered: true, bulletChar: ')', num: parseInt(digits, 10),
      contentIndent: indent + digits.length + 2 + widthOf(m[3]!),
      rest: m[4]!, style: 'paren-number', parenNumber: true,
    };
  }

  // Roman numerals (`i.`, `ii)`) then single letters (`a)`, `b.`). Both need a
  // sibling to be believed — see needsSibling.
  m = /^( {0,5})([ivxIVX]{1,5}|[a-zA-Z])([.)])([ \t]+)(.*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const token = m[2]!;
    const roman = ROMAN_VALUES[token.toLowerCase()];
    const isRoman = token.length > 1 || (roman !== undefined && /^[ivx]$/i.test(token));
    const num = isRoman && roman !== undefined
      ? roman
      : token.toLowerCase().charCodeAt(0) - 96;
    if (token.length > 1 && roman === undefined) return null;
    return {
      ...base, indent, ordered: true, bulletChar: m[3]!, num,
      contentIndent: indent + token.length + 1 + widthOf(m[4]!),
      rest: m[5]!, style: isRoman ? 'roman' : 'alpha',
    };
  }

  // Markers with no space at all: `-Item`, `*Item`, `1.Install`. Only believed
  // as part of a run (needsSibling), and only before a letter or a code span
  // so that `-5`, `--flag` and `3.14` stay text. A run written ``1.`--flag`
  // does a thing`` is common in options docs, and rejecting the backtick split
  // it into a stranded paragraph plus an <ol start="2">.
  m = /^( {0,5})([-*+])([A-Za-zÀ-ɏ一-鿿`][^\n]*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const ch = m[2]!;
    const rest = m[3]!;
    // `*Item*` is emphasis, not a bullet — and so is `*Note*: the rest of the
    // sentence`, where the closing delimiter is mid-line rather than at the
    // end. Reading that as a bullet ate the opening `*` and left the closing
    // one stranded in the text.
    if (ch === '*' && rest.includes('*')) return null;
    return {
      ...base, indent, ordered: false, bulletChar: ch, num: 0,
      contentIndent: indent + 1, rest, style: 'bullet', missingSpace: true,
    };
  }
  m = /^( {0,5})(\d{1,9})([.)])([A-Za-zÀ-ɏ一-鿿`][^\n]*)$/.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const digits = m[2]!;
    return {
      ...base, indent, ordered: true, bulletChar: m[3]!, num: parseInt(digits, 10),
      contentIndent: indent + digits.length + 1, rest: m[4]!,
      style: 'number', missingSpace: true,
    };
  }

  return null;
}

/**
 * Marker shapes that are ambiguous with ordinary prose only count as a list
 * when another item of the same shape follows. A lone "— Ada Lovelace",
 * "a. thing" or "-Text" stays a paragraph; a run of them is clearly a list.
 */
export function needsSibling(marker: ListMarker): boolean {
  return (
    marker.style === 'ambiguous-bullet' ||
    marker.style === 'alpha' ||
    marker.style === 'roman' ||
    marker.style === 'colon-number' ||
    marker.style === 'prose-step' ||
    marker.style === 'escaped-number' ||
    marker.missingSpace
  );
}

export function consumeList(lines: Line[], start: number, first: ListMarker, ctx: Ctx, blocks: Block[]): number {
  const { diag } = ctx;
  const n = lines.length;
  const items: ListItem[] = [];
  const ordered = first.ordered;
  const startNum = ordered ? first.num : 1;
  let loose = false;
  let reportedUnicode = false;
  let reportedParen = false;
  let reportedIndent = false;
  let reportedNonseq = false;
  let reportedMissingSpace = false;
  let reportedAlpha = false;
  /**
   * One stray blank line between items is a slip, not an intent to make the
   * list loose. Two or more means the author really is spacing items out.
   */
  let blankSeparations = 0;
  let prevNum = ordered ? first.num - 1 : 0;

  let i = start;
  let marker: ListMarker | null = first;

  while (i < n && marker) {
    if (marker.unicodeBullet && !reportedUnicode) {
      diag.repair('list-unicode-bullet', `Unicode bullet '${marker.bulletChar}' treated as a list marker`, lines[i]!.lineNo);
      reportedUnicode = true;
    }
    if (marker.parenNumber && !reportedParen) {
      diag.repair('list-paren-number', 'Parenthesized number treated as an ordered-list marker', lines[i]!.lineNo);
      reportedParen = true;
    }
    if (marker.missingSpace && !reportedMissingSpace) {
      diag.repair('list-indent-adjusted', `List marker '${marker.bulletChar}' had no space before the text; treated as a list item`, lines[i]!.lineNo);
      reportedMissingSpace = true;
    }
    if (marker.style === 'escaped-number' && !reportedAlpha) {
      diag.repair('list-paren-number', 'Escaped "1\\." markers treated as an ordered list', lines[i]!.lineNo);
      reportedAlpha = true;
    }
    if ((marker.style === 'alpha' || marker.style === 'roman') && !reportedAlpha) {
      diag.repair('list-paren-number', `${marker.style === 'roman' ? 'Roman numeral' : 'Lettered'} markers treated as an ordered list`, lines[i]!.lineNo);
      reportedAlpha = true;
    }
    if (marker.gluedTask) {
      diag.repair('task-marker-nonstandard', 'Task checkbox glued to the bullet; treated as a task item', lines[i]!.lineNo);
    }
    if (ordered && !reportedNonseq && marker.num !== prevNum + 1 && items.length > 0) {
      diag.note('list-nonsequential-numbers', `Ordered list numbering jumps from ${prevNum} to ${marker.num}`, lines[i]!.lineNo);
      reportedNonseq = true;
    }
    prevNum = marker.num;

    // ---- collect this item's lines ----
    const itemLines: Line[] = [{ text: marker.rest, lineNo: lines[i]!.lineNo }];
    const contentIndent = marker.contentIndent;
    const contThreshold = Math.max(marker.indent + 1, contentIndent - 1);
    let j = i + 1;
    let sawBlankInItem = false;
    let pendingBlanks: Line[] = [];
    let itemEndLine = lines[i]!.lineNo;

    for (; j < n; j++) {
      const t = lines[j]!.text;
      if (isBlank(t)) {
        pendingBlanks.push({ text: '', lineNo: lines[j]!.lineNo });
        continue;
      }
      const ind = indentOf(t);
      const asMarker = matchListMarker(t);

      // An over-indented ordered marker that continues this list's numbering
      // is a sibling that drifted right, not a nested item.
      // Only before a nested list has started inside this item. Once the item
      // contains its own markers, a deeper marker belongs to that sublist —
      // otherwise a canonical `1. / 1. 2. 3. / 2.` tree gets flattened.
      const nestedAlreadyOpen = itemLines.some((l) => !isBlank(l.text) && matchListMarker(l.text) !== null);
      const continuesNumbering =
        asMarker !== null &&
        asMarker.ordered === ordered &&
        ordered &&
        !nestedAlreadyOpen &&
        asMarker.num === marker.num + 1 &&
        compatibleMarker(first, asMarker);

      let isSiblingMarker = asMarker !== null && asMarker.indent < contThreshold;
      if (continuesNumbering && asMarker.indent >= contThreshold) {
        diag.repair('list-indent-adjusted', `Over-indented "${asMarker.num}." continues the outer numbering; kept as a sibling`, lines[j]!.lineNo);
        isSiblingMarker = true;
      }
      // A marker indented past the bullet but short of the content column is
      // a nested item written with a narrow indent.
      const nestsUnderMarker =
        asMarker !== null && !continuesNumbering && asMarker.indent > marker.indent && asMarker.indent < contThreshold;
      if (nestsUnderMarker) isSiblingMarker = false;

      if ((ind >= contThreshold || nestsUnderMarker) && !isSiblingMarker) {
        if (pendingBlanks.length > 0) {
          itemLines.push(...pendingBlanks);
          sawBlankInItem = true;
          pendingBlanks = [];
        }
        if (ind < contentIndent && !reportedIndent && ind > marker.indent) {
          diag.note('list-indent-adjusted', `Continuation indented ${ind} columns (needed ${contentIndent}); kept inside the list item`, lines[j]!.lineNo);
          reportedIndent = true;
        }
        itemLines.push({ text: t.slice(Math.min(ind, contentIndent)), lineNo: lines[j]!.lineNo });
        itemEndLine = lines[j]!.lineNo;
        continue;
      }

      // `3.` alone on a line, with its text on the next line.
      if (itemLines.length === 1 && isBlank(itemLines[0]!.text) && !asMarker && pendingBlanks.length === 0) {
        diag.repair('list-indent-adjusted', 'List marker stood alone on its line; joined it with the text below', lines[j]!.lineNo);
        itemLines[0] = { text: t.trimStart(), lineNo: lines[j]!.lineNo };
        itemEndLine = lines[j]!.lineNo;
        continue;
      }

      // Lazy paragraph continuation (no blank line, not a new block).
      if (pendingBlanks.length === 0 && !asMarker && !startsAnyBlock(t) && itemLines.length > 0 && !isBlank(itemLines[itemLines.length - 1]!.text)) {
        itemLines.push({ text: t.trimStart(), lineNo: lines[j]!.lineNo });
        itemEndLine = lines[j]!.lineNo;
        continue;
      }
      break;
    }

    // A flush-left block sandwiched between two items of this list — a command
    // the model forgot to indent — belongs to the item above it.
    if (j < n && !isBlank(lines[j]!.text) && matchListMarker(lines[j]!.text) === null) {
      const resume = findSandwichedBlockEnd(lines, j, first, pendingBlanks.length === 0);
      if (resume !== -1) {
        diag.repair('list-indent-adjusted', 'Flush-left block between two list items attached to the item above', lines[j]!.lineNo);
        if (pendingBlanks.length > 0) {
          itemLines.push(...pendingBlanks);
          pendingBlanks = [];
        }
        let absorbFence: FenceOpen | null = null;
        let runIndent: boolean | null = null;
        let runEnd = j;
        for (let p = j; p < resume; p++) {
          const src = lines[p]!;
          // Fenced content is never rewritten. `looksLikeCommand` was being
          // asked line by line with no idea it was inside a fence, so it
          // indented `cd LightRAG` and left `uv sync` at column 0 within the
          // same block — shredding the code it was trying to attach.
          if (absorbFence !== null) {
            const bare = matchBareFence(src.text);
            if (bare && bare.char === absorbFence.char && bare.len >= absorbFence.len) absorbFence = null;
            itemLines.push(src);
            continue;
          }
          const opensFence = matchFenceOpen(src.text);
          if (opensFence) {
            absorbFence = opensFence;
            runIndent = null;
            itemLines.push(src);
            continue;
          }
          if (isBlank(src.text)) {
            runIndent = null;
            itemLines.push(src);
            continue;
          }
          // Only a BARE command line becomes an indented code block, and the
          // whole contiguous run goes together. Deciding line by line split a
          // two-line shell block across two indent levels, because a long
          // `git remote set-url …` fails the word-count test that the
          // `git checkout -b dev` under it passes.
          if (runIndent === null) {
            let end = p;
            let anyCommand = false;
            while (end < resume && !isBlank(lines[end]!.text) && matchFenceOpen(lines[end]!.text) === null) {
              if (looksLikeCommand(lines[end]!.text)) anyCommand = true;
              end++;
            }
            runIndent = anyCommand;
            runEnd = end;
          }
          itemLines.push(runIndent ? { text: '    ' + src.text.trim(), lineNo: src.lineNo } : src);
          if (p + 1 >= runEnd) runIndent = null;
        }
        itemEndLine = lines[resume - 1]!.lineNo;
        j = resume;
      }
    }

    if (pendingBlanks.length > 0 && j < n) {
      // blank line(s) between this item and whatever follows
      const nxt = j < n ? matchListMarker(lines[j]!.text) : null;
      if (nxt && compatibleMarker(first, nxt)) blankSeparations++;
    }
    if (sawBlankInItem) loose = true;

    // ---- task checkbox ----
    // Tolerates `[]`, `[ x ]`, `[X]`, `[~]`, `[-]`, `[✓]`, `[✗]` and a missing
    // space after the bracket.
    let checked: boolean | null = null;
    const firstLine = itemLines[0]!;
    const task = /^\[[ \t]*([xX✓✗~-])?[ \t]*\][ \t]*(.*)$/.exec(firstLine.text);
    if (task) {
      const c = task[1];
      checked = c === 'x' || c === 'X' || c === '✓';
      if (c !== undefined && c !== 'x' && c !== ' ') {
        diag.repair(
          'task-marker-nonstandard',
          `Task checkbox '[${c}]' treated as ${checked ? 'checked' : 'not done'}`,
          firstLine.lineNo,
        );
      } else if (c === undefined && !/^\[ *\]/.test(firstLine.text.replace(/\t/g, ' '))) {
        diag.repair('task-marker-nonstandard', "Empty task checkbox '[]' treated as not done", firstLine.lineNo);
      }
      itemLines[0] = { text: task[2]!, lineNo: firstLine.lineNo };
    }

    const normalized = normalizeIndents(itemLines);
    if (normalized.adjusted && !reportedIndent) {
      diag.repair('list-indent-adjusted', 'Child items used inconsistent indent widths; snapped them to one level', firstLine.lineNo);
      reportedIndent = true;
    }
    ctx.depth++;
    const children = ctx.depth >= MAX_NESTING
      ? [{
          type: 'paragraph' as const,
          children: parseInlines(normalized.lines.map((l) => l.text).join('\n'), firstLine.lineNo, ctx),
          pos: { startLine: firstLine.lineNo, endLine: itemEndLine },
        }]
      : parseBlocks(normalized.lines, ctx, false);
    ctx.depth--;
    items.push({
      type: 'listItem',
      checked,
      children,
      pos: { startLine: lines[i]!.lineNo, endLine: itemEndLine },
    });

    // ---- advance to next sibling ----
    i = j;
    marker = null;
    if (i < n) {
      const nxt = matchListMarker(lines[i]!.text);
      if (nxt && compatibleMarker(first, nxt)) {
        // A clean restart at 1 (followed by 2) is a new list, not a slip in
        // the numbering of this one.
        if (ordered && nxt.num === 1 && prevNum >= 2 && restartLooksClean(lines, i)) {
          diag.note('list-nonsequential-numbers', 'Numbering restarted at 1; started a new list', lines[i]!.lineNo);
        } else {
          marker = nxt;
        }
      }
    }
  }

  blocks.push({
    type: 'list',
    ordered,
    start: startNum,
    tight: !loose && blankSeparations < 2,
    children: items,
    pos: { startLine: lines[start]!.lineNo, endLine: items[items.length - 1]!.pos.endLine },
  });
  return i;
}

/**
 * Snap list-marker indents onto canonical levels.
 *
 * LLMs drift between 2, 3 and 4 spaces for what they mean as one level, and a
 * strict parser turns that drift into phantom nesting (or an indented code
 * block). Indents within one column of each other are treated as the same
 * level; a gap of two or more starts a real level. Continuation lines shift
 * with the marker they follow.
 */
/**
 * Which lines sit inside a fenced code block (including the fence lines).
 * Anything in here is content, never structure: a JSDoc ` * ` continuation
 * inside a ```` ```ts ```` block is not a list marker, and reading it as one
 * made the indent normalizer restripe the comment and break its alignment.
 */
function fencedLines(lines: Line[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: FenceOpen | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    if (open !== null) {
      mask[i] = true;
      const bare = matchBareFence(t);
      if (bare && bare.char === open.char && bare.len >= open.len) open = null;
      continue;
    }
    const started = matchFenceOpen(t);
    if (started) {
      open = started;
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * Effective indent to shift each line by: its own, except inside a fence,
 * where every line in the run shares the run's shallowest indent so the block
 * moves rigidly and the code keeps its shape.
 */
function regionIndent(lines: Line[], fenced: boolean[]): number[] {
  const out = lines.map((l) => indentOf(l.text));
  let i = 0;
  while (i < lines.length) {
    if (!fenced[i]) {
      i++;
      continue;
    }
    let j = i;
    let min = Number.POSITIVE_INFINITY;
    while (j < lines.length && fenced[j]) {
      if (!isBlank(lines[j]!.text)) min = Math.min(min, indentOf(lines[j]!.text));
      j++;
    }
    if (!Number.isFinite(min)) min = 0;
    for (let k = i; k < j; k++) out[k] = min;
    i = j;
  }
  return out;
}

export function normalizeIndents(lines: Line[]): { lines: Line[]; adjusted: boolean } {
  const fenced = fencedLines(lines);
  const indents = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isBlank(l.text) || fenced[i]) continue;
    if (matchListMarker(l.text)) indents.add(indentOf(l.text));
  }
  if (indents.size === 0) return { lines, adjusted: false };

  // Pull a uniformly over-indented run of markers back to the left margin.
  // Without this a nested list written at seven spaces reads as indented code.
  // Inside a fence every line must move by the SAME amount or the code's own
  // indentation is destroyed, so a fenced run is shifted by the shallowest
  // indent in that run rather than each line by its own.
  const region = regionIndent(lines, fenced);

  const minMarker = Math.min(...indents);
  if (minMarker > 0) {
    const shifted = lines.map((l, i) =>
      isBlank(l.text) ? l : { text: l.text.slice(Math.min(minMarker, region[i]!)), lineNo: l.lineNo },
    );
    const inner = normalizeIndents(shifted);
    // Pulling a uniformly indented block to the margin changes no hierarchy,
    // so it is only worth reporting when the levels themselves had to move, or
    // when the indent was deep enough that a strict parser would have read the
    // whole run as an indented code block instead of a list.
    return { lines: inner.lines, adjusted: inner.adjusted || minMarker >= 4 };
  }

  if (indents.size < 2) return { lines, adjusted: false };

  // Walk the markers in document order against a stack of open levels. A
  // marker within one column of the current level is at that level (this is
  // what absorbs the drift); clearly deeper opens a level; clearly shallower
  // closes back to the level it belongs to.
  const stack: number[] = [];
  let adjusted = false;
  let delta = 0;

  const out = lines.map((l, i) => {
    if (isBlank(l.text)) return l;
    const ind = indentOf(l.text);

    if (fenced[i] || !matchListMarker(l.text)) {
      // Continuation lines follow the marker they belong to. A fenced line is
      // always continuation, never a marker, and clamps its shift to the run's
      // shallowest indent so the whole block moves as one.
      if (delta === 0) return l;
      const eff = fenced[i] ? Math.max(delta, -region[i]!) : delta;
      const shifted = Math.max(0, ind + eff);
      return { text: ' '.repeat(shifted) + l.text.slice(ind), lineNo: l.lineNo };
    }

    while (stack.length > 1 && ind <= stack[stack.length - 1]! - 1) stack.pop();
    // The base level is not sacred. It was fixed by whichever marker happened
    // to come first, so a genuinely shallower marker later in the item was
    // snapped UP to it and its own children then collided with it at that same
    // level — one whole level of hierarchy gone. Two columns is the same
    // "clearly shallower" margin the push below uses for "clearly deeper", so
    // ordinary one-column drift is still absorbed rather than opening a level.
    if (stack.length === 1 && ind <= stack[0]! - 2) stack.pop();
    const top = stack[stack.length - 1];
    let target: number;
    if (top === undefined || ind > top + 1) {
      stack.push(ind);
      target = ind;
    } else {
      target = top;
    }

    delta = target - ind;
    if (delta !== 0) adjusted = true;
    return delta === 0 ? l : { text: ' '.repeat(target) + l.text.slice(ind), lineNo: l.lineNo };
  });
  return { lines: out, adjusted };
}

/**
 * Guard for ambiguous marker shapes: require a sibling item of the same shape
 * so a single "— Ada Lovelace" or "a. thing" stays a paragraph.
 */
export function listMarkerHasSibling(lines: Line[], start: number, marker: ListMarker): boolean {
  if (!needsSibling(marker)) return true;
  for (let j = start + 1; j < lines.length; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) {
      // Allow one blank line between items of a loose list.
      if (j + 1 < lines.length && !isBlank(lines[j + 1]!.text)) continue;
      break;
    }
    const m = matchListMarker(t);
    if (
      m &&
      m.style === marker.style &&
      m.missingSpace === marker.missingSpace &&
      m.indent === marker.indent &&
      (marker.style !== 'ambiguous-bullet' || m.bulletChar === marker.bulletChar)
    ) {
      return true;
    }
    if (m === null && indentOf(t) < marker.contentIndent) break;
  }
  return false;
}

/**
 * If the un-indented block starting at `start` is followed by another item of
 * this same list, return where that item begins — the block is sandwiched and
 * belongs to the preceding item. Returns -1 when the block instead ends the
 * list (trailing commentary, a new section, a genuinely separate block).
 */
/**
 * Shell commands LLMs put flush-left between numbered steps. Requiring a known
 * executable at the start keeps ordinary prose ("Then, for production:") from
 * being swallowed into the item above.
 */
export const COMMAND_HEADS =
  /^(npm|npx|pip3?|pipx|poetry|yarn|pnpm|bun|deno|docker|docker-compose|kubectl|helm|git|cd|make|cargo|go|rustup|python3?|node|bash|sh|zsh|curl|wget|apt|apt-get|brew|systemctl|journalctl|terraform|ansible|aws|gcloud|az|sudo|export|source|mkdir|cp|mv|rm|chmod|chown|ln|tar|unzip|ssh|scp|rsync|psql|mysql|redis-cli|mvn|gradle|dotnet|composer|rails|bundle|flask|django-admin|alembic|pytest|jest|vitest|eslint|prettier|tsc)\b/;

export function looksLikeCommand(text: string): boolean {
  const s = text.trim();
  if (s === '' || /[.!?]$/.test(s)) return false;
  if (s.split(/\s+/).length > 10) return false;
  return COMMAND_HEADS.test(s);
}

export function findSandwichedBlockEnd(lines: Line[], start: number, first: ListMarker, attached: boolean): number {
  const LIMIT = 25;
  let fence: FenceOpen | null = null;
  let sawAbsorbable = false;
  // Tracked separately: a *fenced* block after the last item is normally a
  // sibling of the list, while a bare command line is orphaned continuation.
  let sawCommand = false;

  for (let j = start; j < lines.length && j - start < LIMIT; j++) {
    const t = lines[j]!.text;

    if (fence) {
      const bare = matchBareFence(t);
      if (bare && bare.char === fence.char && bare.len >= fence.len) fence = null;
      continue;
    }
    const open = matchFenceOpen(t);
    if (open) {
      fence = open;
      sawAbsorbable = true;
      continue;
    }

    if (j > start) {
      const m = matchListMarker(t);
      // Only pull the block in if it was code or a command. A prose paragraph
      // between two lists is a label that legitimately separates them.
      // Absorb only a block the author attached to the item — no blank line
      // between them. `1. step` / blank / fence / blank / `2. step` is an
      // ordinary idiom that every parser renders sensibly, and pulling those
      // fences into the item made parallel steps render at different indents
      // depending on whether another item happened to follow. A bare command
      // is still rescued across a blank line, because nothing else will.
      if (m && compatibleMarker(first, m)) return (attached || sawCommand) && sawAbsorbable ? j : -1;
    }
    if (isBlank(t)) continue;
    if (looksLikeCommand(t)) {
      sawAbsorbable = true;
      sawCommand = true;
      continue;
    }
    // Anything else — prose, a heading, a rule — ends the list. But a block
    // the author attached directly under the item belongs to that item no
    // matter what follows it. Requiring another list item afterwards made the
    // last of three parallel bullets keep its fence at the margin while the
    // first two nested, purely because a heading came next.
    return attached && sawAbsorbable ? j : -1;
  }
  // Ran to the end of input with no further item. A trailing bare command is
  // orphaned continuation of the last step, and so is a block that touches the
  // item with no blank line between. A fenced block set off by a blank line is
  // a sibling of the list, not part of it.
  return sawCommand || (attached && sawAbsorbable) ? Math.min(start + LIMIT, lines.length) : -1;
}

/**
 * Does the restart at `start` begin a genuinely new sequence (1, 2, 3…) rather
 * than a one-off numbering slip the author immediately abandoned?
 */
export function restartLooksClean(lines: Line[], start: number): boolean {
  let expected = 2;
  for (let j = start + 1; j < lines.length && expected <= 3; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) continue;
    const m = matchListMarker(t);
    if (!m) {
      if (indentOf(t) > 0) continue; // continuation of the item
      return false;
    }
    if (!m.ordered) return false;
    if (m.num !== expected) return false;
    expected++;
  }
  return expected > 2;
}

export function compatibleMarker(a: ListMarker, b: ListMarker): boolean {
  if (a.ordered !== b.ordered) return false;
  // Lettered and roman runs are their own lists — they must not absorb a
  // numeric run that happens to follow.
  const family = (m: ListMarker): string =>
    m.style === 'alpha' || m.style === 'roman' || m.style === 'prose-step' ||
    m.style === 'colon-number' || m.style === 'escaped-number'
      ? m.style
      : m.ordered
        ? 'number'
        : 'bullet';
  if (family(a) !== family(b)) return false;
  // Tolerance: bullet-char switches (- to *) continue the same list; LLMs
  // switch characters mid-list by accident.
  return true;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
