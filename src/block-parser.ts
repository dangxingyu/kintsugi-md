import type {
  Block,
  CodeBlock,
  DefinitionItem,
  Heading,
  Inline,
} from './types.js';
import type { Line } from './preprocess.js';
import { indentOf, isBlank } from './preprocess.js';
import {
  delimiterPipeCount,
  isWeakRowCandidate,
  parseSeparatorRow,
} from './table-shape.js';
import { inlinePlainText, parseInlines } from './inline-parser.js';
import { isHeadingByModel, ruleSignalApplies } from './classifier.js';
import type { FenceOpen } from './scanners.js';
import type { Ctx } from './context.js';
import { MAX_NESTING } from './context.js';
import { consumeList, listMarkerHasSibling, matchListMarker, needsSibling } from './list-parser.js';
import { tryConsumeTable } from './table-parser.js';
import {
  MD_FENCE_LANGS,
  hasMatchingCloser,
  isControlTokenLine,
  looksLikeLanguage,
  matchAtxHeading,
  matchBareFence,
  matchFenceLine,
  matchFenceOpen,
  matchHtmlBlockStart,
  matchMathBlockOpen,
  matchScaffolding,
  matchThematicBreak,
  normalizeLang,
} from './scanners.js';

function interruptsParagraph(text: string, nextText: string | null): boolean {
  if (matchFenceOpen(text)) return true;
  const h = matchAtxHeading(text);
  if (h && (!h.missingSpace || text.trimStart().startsWith('##'))) return true;
  if (matchThematicBreak(text)) return true;
  if (/^ {0,3}>/.test(text)) return true;
  // Ambiguous marker shapes need a sibling run to be believed, which this
  // context-free check cannot see; they must not split a paragraph.
  const lm = matchListMarker(text);
  if (lm && !needsSibling(lm) && lm.rest !== '' && (!lm.ordered || lm.num <= 99)) return true;
  if (matchHtmlBlockStart(text)) return true;
  if (matchMathBlockOpen(text)) return true;
  if (isControlTokenLine(text)) return true;
  if (nextText !== null && isWeakRowCandidate(text) && parseSeparatorRow(nextText)) return true;
  return false;
}

/** Used to stop lazy continuation into blockquotes/list items. */
export function startsAnyBlock(text: string): boolean {
  return interruptsParagraph(text, null) || indentOf(text) >= 4;
}

// ---------------------------------------------------------------------------
// The block parser
// ---------------------------------------------------------------------------

/**
 * Does this `'''` opener have a closer? Memoized per line-array, because the
 * naive check rescans to end of input and a file full of Python docstrings
 * would then be quadratic.
 */
const apostropheCloserCache = new WeakMap<Line[], Set<number>>();
function apostropheFenceCloses(lines: Line[], i: number, fence: FenceOpen, _ctx: Ctx): boolean {
  let closers = apostropheCloserCache.get(lines);
  if (closers === undefined) {
    closers = new Set<number>();
    for (let k = 0; k < lines.length; k++) {
      const bare = matchBareFence(lines[k]!.text);
      if (bare && bare.char === "'") closers.add(k);
    }
    apostropheCloserCache.set(lines, closers);
  }
  for (const k of closers) if (k > i) return true;
  return false;
}

export function parseBlocks(lines: Line[], ctx: Ctx, atDocStart: boolean): Block[] {
  const { diag } = ctx;
  const blocks: Block[] = [];
  const n = lines.length;
  let i = 0;

  const inline = (text: string, lineNo: number) => parseInlines(text, lineNo, ctx);

  // ------ frontmatter (document start only) ------
  if (atDocStart && ctx.options.frontmatter) {
    while (i < n && isBlank(lines[i]!.text)) i++;
    if (i < n && /^---\s*$/.test(lines[i]!.text)) {
      const second = lines[i + 1];
      const yamlish = second !== undefined && (/^[\w"'[\]$@-]+\s*:(\s|$)/.test(second.text) || /^#/.test(second.text));
      if (yamlish) {
        let close = -1;
        for (let j = i + 1; j < n; j++) {
          if (/^(---|\.\.\.)\s*$/.test(lines[j]!.text)) {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          blocks.push({
            type: 'frontmatter',
            value: lines.slice(i + 1, close).map((l) => l.text).join('\n'),
            pos: { startLine: lines[i]!.lineNo, endLine: lines[close]!.lineNo },
          });
          i = close + 1;
        } else {
          // Never closed: end the block at the first line that stops looking
          // like YAML, so the rest of the document still parses as markdown.
          // `#` is deliberately NOT accepted as a YAML comment here: a line
          // like `# Overview` is far more likely the document's first heading.
          let k = i + 1;
          while (k < n && (isBlank(lines[k]!.text) || /^(\s+\S|[\w"'[\]$@.-]+\s*:(\s|$)|- )/.test(lines[k]!.text))) k++;
          while (k > i + 1 && isBlank(lines[k - 1]!.text)) k--;
          if (k > i + 1) {
            diag.repair('frontmatter-unclosed', 'Frontmatter was never closed; ended it where the content stops looking like YAML', lines[i]!.lineNo);
            blocks.push({
              type: 'frontmatter',
              value: lines.slice(i + 1, k).map((l) => l.text).join('\n'),
              pos: { startLine: lines[i]!.lineNo, endLine: lines[k - 1]!.lineNo },
            });
            i = k;
          } else {
            diag.note('frontmatter-unclosed', 'Line looks like a frontmatter opener but is never closed; treating --- as a thematic break', lines[i]!.lineNo);
          }
        }
      }
    }
  }

  while (i < n) {
    const line = lines[i]!;
    const text = line.text;

    if (isBlank(text)) {
      i++;
      continue;
    }

    if (ctx.refLines.has(line.lineNo)) {
      i++;
      continue;
    }

    const indent = indentOf(text);

    // ------ indented chunk: code block or misindented prose ------
    if (indent >= 4) {
      i = consumeIndentedChunk(lines, i, ctx, blocks);
      continue;
    }

    // ------ fenced code ------
    const fence = matchFenceOpen(text);
    // `'''` is only a fence when a matching closer exists; otherwise stray
    // quotes in prose would swallow the rest of the document.
    if (fence && (fence.char !== "'" || apostropheFenceCloses(lines, i, fence, ctx))) {
      i = consumeFence(lines, i, fence, ctx, blocks);
      continue;
    }

    // ------ math block ------
    if (ctx.options.math) {
      const math = matchMathBlockOpen(text);
      if (math) {
        const consumed = consumeMathBlock(lines, i, math, ctx, blocks);
        if (consumed !== -1) {
          i = consumed;
          continue;
        }
      }
    }

    // ------ leaked model scaffolding ------
    const scaffold = matchScaffolding(lines, i);
    if (scaffold !== null) {
      diag.note('scaffolding-removed', `Leaked model scaffolding (${scaffold.kind}) kept in the AST but excluded from rendered output`, line.lineNo);
      blocks.push({
        type: 'scaffolding',
        kind: scaffold.kind,
        value: lines.slice(i, scaffold.end).map((l) => l.text).join('\n'),
        pos: { startLine: line.lineNo, endLine: lines[scaffold.end - 1]!.lineNo },
      });
      i = scaffold.end;
      continue;
    }

    // ------ HTML block ------
    const html = matchHtmlBlockStart(text);
    if (html) {
      i = consumeHtmlBlock(lines, i, html, ctx, blocks);
      continue;
    }

    // ------ ATX heading ------
    const heading = matchAtxHeading(text);
    if (heading) {
      if (heading.missingSpace) {
        diag.repair('heading-missing-space', `Treated "${text.trim().slice(0, 30)}" as a heading despite missing space after '#'`, line.lineNo);
      }
      if (heading.overDeep) {
        diag.repair('heading-depth-clamped', `Heading with ${heading.overDeep} '#' clamped to depth 6`, line.lineNo);
      }
      blocks.push({
        type: 'heading',
        depth: heading.depth as Heading['depth'],
        children: inline(heading.content, line.lineNo),
        setext: false,
        pos: { startLine: line.lineNo, endLine: line.lineNo },
      });
      i++;
      continue;
    }

    // ------ thematic break (before lists: `- - -` beats bullet) ------
    const hr = matchThematicBreak(text);
    if (hr) {
      if (hr.nonstandard) {
        diag.repair('hr-nonstandard-chars', 'Nonstandard separator line treated as a thematic break', line.lineNo);
      }
      // Collapse a run of separators — models emit `---` several times in a
      // row as visual spacing, and a stack of empty rules is just noise.
      let k = i + 1;
      let extra = 0;
      for (;;) {
        let p = k;
        while (p < n && isBlank(lines[p]!.text)) p++;
        if (p >= n || !matchThematicBreak(lines[p]!.text)) break;
        k = p + 1;
        extra++;
      }
      if (extra > 0) {
        diag.note('hr-nonstandard-chars', `Collapsed ${extra + 1} consecutive separator lines into one rule`, line.lineNo);
      }
      blocks.push({ type: 'thematicBreak', pos: { startLine: line.lineNo, endLine: lines[k - 1]!.lineNo } });
      i = k;
      continue;
    }

    // ------ blockquote ------
    if (/^ {0,3}>/.test(text)) {
      i = consumeBlockquote(lines, i, ctx, blocks);
      continue;
    }

    // ------ ::: container ------
    const container = /^ {0,3}:{3,}[ \t]*([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(text);
    if (container) {
      i = consumeContainer(
        lines,
        i,
        { kind: container[1]!.toLowerCase(), title: container[2]!.trim() === '' ? null : container[2]!.trim() },
        ctx,
        blocks,
      );
      continue;
    }

    // ------ definition list ------
    if (i + 1 < n && /^ {0,3}:[ \t]+\S/.test(lines[i + 1]!.text) && !isBlank(text) && delimiterPipeCount(text) === 0) {
      i = consumeDefinitionList(lines, i, ctx, blocks);
      continue;
    }

    // ------ list ------
    const marker = matchListMarker(text);
    if (
      marker &&
      (marker.rest !== '' || (i + 1 < n && !isBlank(lines[i + 1]!.text))) &&
      (marker.style !== 'escaped-number' || ctx.richDocument) &&
      listMarkerHasSibling(lines, i, marker)
    ) {
      i = consumeList(lines, i, marker, ctx, blocks);
      continue;
    }

    // ------ table ------
    const tableEnd = tryConsumeTable(lines, i, ctx, blocks, false);
    if (tableEnd !== -1) {
      i = tableEnd;
      continue;
    }

    // ------ unfenced config block ------
    const configEnd = matchConfigBlock(lines, i, blocks);
    if (configEnd !== -1) {
      diag.repair('indented-prose-not-code', 'Configuration-shaped lines after a colon treated as a code block', line.lineNo);
      blocks.push({
        type: 'codeBlock',
        info: '',
        lang: '',
        value: lines.slice(i, configEnd).map((l) => l.text.trimStart()).join('\n'),
        fenced: false,
        autoClosed: false,
        pos: { startLine: line.lineNo, endLine: lines[configEnd - 1]!.lineNo },
      });
      i = configEnd;
      continue;
    }

    // ------ paragraph (with setext / interrupt logic) ------
    i = consumeParagraph(lines, i, ctx, blocks);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Individual consumers
// ---------------------------------------------------------------------------

interface FenceScan {
  content: string[];
  closed: boolean;
  end: number;
  usedNesting: boolean;
  mismatch: { code: 'fence-mismatched-char' | 'fence-mismatched-length' | 'fence-close-trailing-text'; message: string; line: number } | null;
}

/** Scan for a fence's closer. `trackNesting` treats inner fences as content. */
function scanFence(lines: Line[], start: number, fence: FenceOpen, trackNesting: boolean): FenceScan {
  const n = lines.length;
  const content: string[] = [];
  let depth = 0;
  let usedNesting = false;
  let mismatch: FenceScan['mismatch'] = null;

  const openerLang = normalizeLang(fence.info);

  // Positions of exact closers (same char, long enough, bare). Fuzzy closers —
  // wrong char, short runs, trailing info — are only believed when NO exact
  // closer exists further down. The audit showed why this matters: every one
  // of 82 sampled fuzzy-closer firings on real READMEs was wrong. A '''
  // docstring inside a ```python block was closing the block; a ```json line
  // that OPENED the next block was consumed as this block's closer, inverting
  // open/closed parity for the whole rest of the document.
  const exactCloserExists = (from: number): boolean => {
    for (let k = from; k < n; k++) {
      const b = matchBareFence(lines[k]!.text);
      if (b && b.char === fence.char && b.len >= fence.len) return true;
    }
    return false;
  };

  for (let j = start + 1; j < n; j++) {
    const t = lines[j]!.text;
    const fl = matchFenceLine(t);

    if (fl) {
      // Inside a ```markdown block, an inner fence that names a *different*
      // language is example content; track its depth so its closer is not
      // mistaken for ours.
      if (trackNesting && fl.info !== '' && looksLikeLanguage(fl.info) && normalizeLang(fl.info) !== openerLang) {
        depth++;
        usedNesting = true;
        content.push(stripIndent(t, fence.indent));
        continue;
      }
      if (trackNesting && depth > 0 && fl.info === '') {
        depth--;
        usedNesting = true;
        content.push(stripIndent(t, fence.indent));
        continue;
      }

      const sameChar = fl.char === fence.char;
      const exact = sameChar && fl.info === '' && fl.len >= fence.len;
      // A closer may carry trailing text ("``` (end of query)") or repeat the
      // opener's language ("```python"); neither starts a new block here.
      const closerish = fl.info === '' || !looksLikeLanguage(fl.info) || normalizeLang(fl.info) === openerLang;

      // Anything short of an exact closer is a repair, and repairs yield to
      // the strict reading whenever the strict reading still has a closer.
      if (!exact && exactCloserExists(j + (sameChar && fl.info === '' ? 1 : 0))) {
        content.push(stripIndent(t, fence.indent));
        continue;
      }

      if (sameChar && closerish) {
        if (fl.info !== '') {
          mismatch = {
            code: 'fence-close-trailing-text',
            message: `Closing fence carried trailing text ("${fl.info.slice(0, 30)}"); treated as the closer`,
            line: lines[j]!.lineNo,
          };
        } else if (fl.len < fence.len) {
          mismatch = {
            code: 'fence-mismatched-length',
            message: `Closing fence has ${fl.len} chars, opener had ${fence.len}; accepted as closer`,
            line: lines[j]!.lineNo,
          };
        }
        return { content, closed: true, end: j, usedNesting, mismatch };
      }
      if (!sameChar && fl.info === '' && fl.len >= 3 && fl.char !== "'" && fence.char !== "'") {
        mismatch = {
          code: 'fence-mismatched-char',
          message: `Closing fence uses '${fl.char}' but opener used '${fence.char}'; accepted as closer`,
          line: lines[j]!.lineNo,
        };
        return { content, closed: true, end: j, usedNesting, mismatch };
      }
    }

    content.push(stripIndent(t, fence.indent));
  }

  return { content, closed: false, end: n - 1, usedNesting, mismatch };
}

/**
 * Index of the closing fence when `start` opens a fence that wraps the whole
 * remaining input (nothing before it, nothing after its closer), with an even
 * number of fence lines in between so inner examples pair up. Returns -1 when
 * that reading does not apply.
 */
function matchWholeInputEnvelope(lines: Line[], start: number, fence: FenceOpen): number {
  const n = lines.length;
  for (let i = 0; i < start; i++) if (!isBlank(lines[i]!.text)) return -1;

  let last = n - 1;
  while (last > start && isBlank(lines[last]!.text)) last--;
  if (last <= start + 1) return -1;

  const closer = matchFenceLine(lines[last]!.text);
  if (!closer || closer.char !== fence.char || closer.info !== '' || closer.len < fence.len) return -1;

  let between = 0;
  for (let i = start + 1; i < last; i++) {
    if (matchFenceLine(lines[i]!.text)) between++;
  }
  // Needs inner fences to pair; with none, the ordinary scan already gets it
  // right and this reading would only mask an unclosed fence.
  if (between === 0) return -1;
  return between % 2 === 0 ? last : -1;
}

function consumeFence(lines: Line[], start: number, fence: FenceOpen, ctx: Ctx, blocks: Block[]): number {
  const { diag } = ctx;
  const n = lines.length;
  const openLine = lines[start]!;
  const lang = normalizeLang(fence.info);

  const trackNesting = MD_FENCE_LANGS.has(lang);

  // A markdown-tagged fence — or a bare one — that spans the whole input is an
  // envelope around content that may itself contain fences. Pair it
  // outermost-to-outermost rather than closing at the first inner fence.
  if (trackNesting || fence.info === '') {
    const envelope = matchWholeInputEnvelope(lines, start, fence);
    if (envelope !== -1) {
      diag.note('fence-nested-markdown', 'Fence wraps the entire input; paired it with the last fence line so nested examples stay inside', openLine.lineNo);
      const content: string[] = [];
      for (let k = start + 1; k < envelope; k++) content.push(stripIndent(lines[k]!.text, fence.indent));
      blocks.push({
        type: 'codeBlock',
        info: fence.info,
        lang,
        value: content.join('\n'),
        fenced: true,
        autoClosed: false,
        pos: { startLine: openLine.lineNo, endLine: lines[envelope]!.lineNo },
      });
      return envelope + 1;
    }
  }

  let scan = scanFence(lines, start, fence, trackNesting);

  // If nesting tracking ran off the end of the document, an inner fence was
  // itself unclosed and swallowed our real closer. Redo without nesting —
  // one unclosed block beats one unclosed document.
  if (!scan.closed && scan.usedNesting) {
    const flat = scanFence(lines, start, fence, false);
    if (flat.closed) scan = flat;
  }

  if (scan.usedNesting && scan.closed) {
    diag.note('fence-nested-markdown', 'Tracked nested fences inside a markdown-language fence to find the real closer', openLine.lineNo);
  }
  if (scan.mismatch) {
    diag.repair(scan.mismatch.code, scan.mismatch.message, scan.mismatch.line);
  }

  if (!scan.closed) {
    // An unclosed fence otherwise swallows the whole rest of the document. If
    // unmistakable markdown structure resumes below, close the fence there
    // instead — the author forgot the closer, they did not mean to code-block
    // their remaining sections.
    const cut = findMarkdownResumption(lines, start);
    if (cut !== -1) {
      diag.repair(
        'fence-unclosed',
        `Code fence opened at line ${openLine.lineNo} was never closed; auto-closed at line ${lines[cut]!.lineNo} where markdown structure resumes`,
        openLine.lineNo,
      );
      const content: string[] = [];
      for (let k = start + 1; k < cut; k++) content.push(stripIndent(lines[k]!.text, fence.indent));
      while (content.length > 0 && isBlank(content[content.length - 1]!)) content.pop();
      blocks.push({
        type: 'codeBlock',
        info: fence.info,
        lang,
        value: content.join('\n'),
        fenced: true,
        autoClosed: true,
        pos: { startLine: openLine.lineNo, endLine: lines[Math.max(cut - 1, start)]!.lineNo },
      });
      return cut;
    }
    diag.repair('fence-unclosed', `Code fence opened at line ${openLine.lineNo} was never closed; auto-closed at end of input`, openLine.lineNo);
  }

  let info = fence.info;
  let finalLang = lang;
  let content = scan.content;

  // The language token slid onto the first content line: ``` then `python`.
  if (info === '' && content.length > 1) {
    const firstLine = content[0]!.trim();
    // Only hoist when what follows actually reads as code. Otherwise the first
    // line is the opening word of a sentence ("python\nis a great language…").
    const rest = content.slice(1).filter((l) => l.trim() !== '');
    const looksLikeCode = rest.some((l) =>
      /[(){};=[\]]|:\s*$|^\s{2,}\S|^\s*(def|class|function|import|from|const|let|var|if|for|while|return|print|echo|SELECT)\b/.test(l),
    );
    const readsAsProse = rest.length > 0 && rest.every((l) => /^[a-z].*[.!?]$/.test(l.trim()));
    if (looksLikeCode && !readsAsProse && /^[a-zA-Z][\w+#.-]{0,15}$/.test(firstLine) && KNOWN_LANGS.has(normalizeLang(firstLine))) {
      finalLang = normalizeLang(firstLine);
      info = firstLine;
      content = content.slice(1);
      diag.repair('fence-close-trailing-text', `Language tag "${firstLine}" had slipped onto the first content line; treated as the info string`, openLine.lineNo);
    }
  }

  // A json-tagged fence whose body is plainly YAML (no JSON braces, but
  // `key: value` lines). Only the label changes; the content is untouched.
  if (finalLang === 'json' && content.length > 0) {
    const body = content.join('\n').trim();
    const yamlish = content.filter((l) => /^\s*[\w".-]+\s*:(\s|$)/.test(l) || /^\s*-\s+\S/.test(l)).length;
    if (!body.startsWith('{') && !body.startsWith('[') && yamlish >= Math.ceil(content.filter((l) => l.trim() !== '').length * 0.6)) {
      diag.repair('fence-close-trailing-text', 'Fence was tagged `json` but the body is YAML; relabelled the language', openLine.lineNo);
      finalLang = 'yaml';
    }
  }

  const node: CodeBlock = {
    type: 'codeBlock',
    info,
    lang: finalLang,
    value: content.join('\n'),
    fenced: true,
    autoClosed: !scan.closed,
    pos: { startLine: openLine.lineNo, endLine: lines[scan.end]!.lineNo },
  };
  blocks.push(node);
  return scan.closed ? scan.end + 1 : n;
}

const KNOWN_LANGS = new Set([
  'python', 'javascript', 'typescript', 'bash', 'json', 'yaml', 'html', 'css', 'sql', 'java',
  'go', 'rust', 'ruby', 'php', 'c', 'cpp', 'csharp', 'swift', 'kotlin', 'scala', 'r', 'perl',
  'lua', 'dart', 'elixir', 'haskell', 'clojure', 'markdown', 'xml', 'toml', 'ini', 'diff',
  'dockerfile', 'makefile', 'graphql', 'protobuf', 'latex', 'matlab', 'julia', 'text', 'plaintext',
]);

/**
 * For an unclosed fence, find the line where the document clearly stops being
 * code and goes back to being markdown. Returns that line's index, or -1.
 *
 * Deliberately conservative: it needs a blank line, then an ATX heading with a
 * space (so `#!/bin/sh` and bare `# comment` lines in code never qualify), and
 * several more structural signals below. Anything weaker risks truncating a
 * genuine code block that merely contains comments.
 */
function findMarkdownResumption(lines: Line[], fenceStart: number): number {
  const n = lines.length;
  const isHeading = (t: string): boolean => /^#{2,6} +\S/.test(t);
  // A header row immediately followed by a separator row is as unambiguous a
  // "this is markdown again" signal as a heading.
  const isTableStart = (i: number): boolean =>
    i + 1 < n && isWeakRowCandidate(lines[i]!.text) && parseSeparatorRow(lines[i + 1]!.text) !== null;

  for (let i = fenceStart + 2; i < n; i++) {
    if (!isBlank(lines[i - 1]!.text)) continue;
    if (!isHeading(lines[i]!.text) && !isTableStart(i)) continue;

    let signals = isTableStart(i) ? 2 : 0;
    for (let k = i; k < n; k++) {
      const t = lines[k]!.text;
      if (isHeading(t)) signals++;
      else if (/^ {0,3}([-*+•●‣]|\d+[.)]) +\S/.test(t)) signals++;
      else if (/^ {0,3}\|.*\|/.test(t)) signals++;
      else if (/^ {0,3}> +\S/.test(t)) signals++;
      // A full prose sentence is a signal too: code comments are terse and
      // rarely end in a period, so this stays clear of real code blocks.
      else if (/^[A-Z][^\n]{20,}[.!?]$/.test(t.trim()) && t.trim().split(/\s+/).length >= 5) signals++;
      if (signals >= 2) return i;
    }
    return -1;
  }
  return -1;
}

function stripIndent(text: string, width: number): string {
  let k = 0;
  while (k < width && k < text.length && text[k] === ' ') k++;
  return text.slice(k);
}

function consumeMathBlock(
  lines: Line[],
  start: number,
  math: { delim: '$$' | '\\[' | 'env'; rest: string; env?: string },
  ctx: Ctx,
  blocks: Block[],
): number {
  const { diag } = ctx;
  const n = lines.length;
  const openLine = lines[start]!;

  // A bare \begin{env} ... \end{env} block: capture verbatim through \end.
  if (math.delim === 'env') {
    const endRe = new RegExp(`\\\\end\\{${math.env!.replace(/[*]/g, '\\*')}\\}`);
    const content: string[] = [];
    for (let j = start; j < n; j++) {
      content.push(lines[j]!.text);
      if (endRe.test(lines[j]!.text)) {
        blocks.push({
          type: 'mathBlock',
          value: content.join('\n').trim(),
          pos: { startLine: openLine.lineNo, endLine: lines[j]!.lineNo },
        });
        return j + 1;
      }
    }
    diag.repair('math-auto-closed', `LaTeX \\begin{${math.env}} was never closed; auto-closed at end of input`, openLine.lineNo);
    blocks.push({
      type: 'mathBlock',
      value: content.join('\n').trim(),
      pos: { startLine: openLine.lineNo, endLine: lines[n - 1]!.lineNo },
    });
    return n;
  }

  const closeRe = math.delim === '$$' ? /^(.*?)\$\$\s*$/ : /^(.*?)\\\]\s*$/;

  // One-liner: $$ x^2 $$  or  \[ x^2 \]
  const one = closeRe.exec(math.rest);
  if (one && (math.delim === '$$' ? !one[1]!.includes('$$') : true)) {
    const value = one[1]!.trim();
    if (value !== '' || math.rest.trim() !== '') {
      blocks.push({
        type: 'mathBlock',
        value,
        pos: { startLine: openLine.lineNo, endLine: openLine.lineNo },
      });
      return start + 1;
    }
  }

  // Multi-line: collect until closing delimiter; stop at a blank line to
  // bound the damage of a stray opener (display math rarely has blank lines).
  const content: string[] = [];
  if (math.rest.trim() !== '') content.push(math.rest);
  for (let j = start + 1; j < n; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) {
      diag.repair('math-auto-closed', `Math block opened at line ${openLine.lineNo} was never closed; auto-closed at blank line`, openLine.lineNo);
      blocks.push({
        type: 'mathBlock',
        value: content.join('\n').trim(),
        pos: { startLine: openLine.lineNo, endLine: lines[j - 1]!.lineNo },
      });
      return j;
    }
    const m = closeRe.exec(t);
    if (m) {
      content.push(m[1]!);
      blocks.push({
        type: 'mathBlock',
        value: content.join('\n').trim(),
        pos: { startLine: openLine.lineNo, endLine: lines[j]!.lineNo },
      });
      return j + 1;
    }
    content.push(t);
  }

  diag.repair('math-auto-closed', `Math block opened at line ${openLine.lineNo} was never closed; auto-closed at end of input`, openLine.lineNo);
  blocks.push({
    type: 'mathBlock',
    value: content.join('\n').trim(),
    pos: { startLine: openLine.lineNo, endLine: lines[n - 1]!.lineNo },
  });
  return n;
}

function consumeHtmlBlock(
  lines: Line[],
  start: number,
  info: { tag: string; rawText: boolean; comment: boolean },
  ctx: Ctx,
  blocks: Block[],
): number {
  const n = lines.length;
  const collected: string[] = [];
  let j = start;

  if (info.comment) {
    for (; j < n; j++) {
      collected.push(lines[j]!.text);
      if (lines[j]!.text.includes('-->')) {
        j++;
        break;
      }
    }
  } else if (info.rawText) {
    const closeRe = new RegExp(`</${info.tag}\\s*>`, 'i');
    for (; j < n; j++) {
      collected.push(lines[j]!.text);
      if (closeRe.test(lines[j]!.text)) {
        j++;
        break;
      }
    }
  } else {
    for (; j < n; j++) {
      if (isBlank(lines[j]!.text)) break;
      collected.push(lines[j]!.text);
    }
  }

  // A container tag on its own line wrapping markdown — the callout pattern
  // (`<div class="warning">` … `</div>`). CommonMark leaves the inside raw, so
  // the `**bold**` a model writes there never renders. Parse it as markdown and
  // keep the tags around it.
  if (!info.comment && !info.rawText && collected.length >= 3) {
    const openTag = collected[0]!.trim();
    const closeTag = collected[collected.length - 1]!.trim();
    const isContainer = /^<(div|section|aside|details|figure|blockquote)\b[^>]*>$/i.test(openTag);
    const closesIt = new RegExp(`^</${info.tag}\\s*>$`, 'i').test(closeTag);
    const body = collected.slice(1, -1);
    const hasMarkdown = body.some((l) =>
      /(\*\*|__|`|^\s*[-*+] |^\s*\d+[.)] |^\s*#{1,6} |\[[^\]]+\]\()/.test(l),
    );
    if (isContainer && closesIt && hasMarkdown) {
      ctx.diag.note('extension-syntax', 'Parsed markdown inside an HTML container block', lines[start]!.lineNo);
      blocks.push({
        type: 'htmlBlock',
        value: openTag,
        pos: { startLine: lines[start]!.lineNo, endLine: lines[start]!.lineNo },
      });
      ctx.depth++;
      if (ctx.depth < MAX_NESTING) {
        blocks.push(...parseBlocks(body.map((t, k) => ({ text: t, lineNo: lines[start]!.lineNo + 1 + k })), ctx, false));
      }
      ctx.depth--;
      blocks.push({
        type: 'htmlBlock',
        value: closeTag,
        pos: { startLine: lines[Math.min(j, n) - 1]!.lineNo, endLine: lines[Math.min(j, n) - 1]!.lineNo },
      });
      return j;
    }
  }

  const raw = collected.join('\n');

  // Tags this block leaves open are NOT evidence of broken HTML. The dominant
  // real-world pattern is a container split across blank lines:
  //
  //   <details>
  //   <summary>…</summary>
  //                       <- blank line ends the CommonMark block
  //   markdown body…
  //
  //   </details>          <- the closer, blocks later
  //
  // An audit across 3,090 READMEs found the old per-block balancing appended a
  // closer here 5,343 times with zero true positives — emptying every
  // <details> on GitHub, breaking side-by-side <table> layouts, and revealing
  // quiz answers the author deliberately hid. Only balance when the tag's
  // closer appears NOWHERE later in the document; then it is genuinely
  // unclosed and a sanitizer downstream would otherwise eat everything after.
  const unclosed = openTagsOf(raw);
  const fromLineNo = lines[Math.min(j, n) - 1]!.lineNo;
  const trulyUnclosed = unclosed.filter((tag) => !closerAppearsLater(ctx, fromLineNo, tag));
  if (trulyUnclosed.length > 0) {
    ctx.diag.repair(
      'html-escaped-unknown-tag',
      `HTML ${trulyUnclosed.map((t) => '<' + t + '>').join(', ')} never closed anywhere below; appended the missing closing tags`,
      lines[start]!.lineNo,
    );
    blocks.push({
      type: 'htmlBlock',
      value: raw + '\n' + trulyUnclosed.reverse().map((t) => `</${t}>`).join(''),
      pos: { startLine: lines[start]!.lineNo, endLine: lines[Math.min(j, n) - 1]!.lineNo },
    });
    return j;
  }
  blocks.push({
    type: 'htmlBlock',
    value: raw,
    pos: { startLine: lines[start]!.lineNo, endLine: lines[Math.min(j, n) - 1]!.lineNo },
  });
  return j;
}

/** HTML elements that never have a closing tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/** Tags left open by this fragment, outermost first. */
function openTagsOf(html: string): string[] {
  const open: string[] = [];
  // Commented-out markup is not markup. Without this, `<!-- <Flowchart> -->`
  // invents a `</flowchart>` and a commented-out `<table>` gets a fabricated
  // `</table>` injected into live output — closers conjured from text the
  // author deliberately disabled.
  const live = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  // The attribute run is lazy so it cannot swallow the self-closing slash:
  // `<a name="11"/>` is self-closing, not an unclosed anchor.
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(live)) !== null) {
    const tag = m[2]!.toLowerCase();
    if (VOID_TAGS.has(tag) || m[3] === '/') continue;
    if (m[1] === '/') {
      const idx = open.lastIndexOf(tag);
      if (idx !== -1) open.splice(idx, 1);
      continue;
    }
    open.push(tag);
  }
  return open;
}

/**
 * Does `</tag>` appear at or after this source line, anywhere in the document?
 *
 * Deliberately consults the document-wide index on `ctx` rather than the line
 * array being parsed: that array is a slice when we are inside a list item or
 * blockquote, and the closer is often outside it.
 */
function closerAppearsLater(ctx: Ctx, fromLineNo: number, tag: string): boolean {
  const list = ctx.htmlClosers.get(tag.toLowerCase());
  if (list === undefined) return false;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! >= fromLineNo) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length;
}

function consumeIndentedChunk(lines: Line[], start: number, ctx: Ctx, blocks: Block[]): number {
  const { diag } = ctx;
  const n = lines.length;
  const collected: Line[] = [];
  let j = start;
  let lastNonBlank = start;

  for (; j < n; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) {
      collected.push(lines[j]!);
      continue;
    }
    if (indentOf(t) >= 4) {
      collected.push(lines[j]!);
      lastNonBlank = j;
      continue;
    }
    break;
  }
  // Trim trailing blanks.
  const chunk = collected.slice(0, lastNonBlank - start + 1);
  const end = lastNonBlank + 1;

  const dedented = chunk.map((l) => ({ text: l.text.slice(Math.min(4, indentOf(l.text))), lineNo: l.lineNo }));

  // Heuristic: LLMs almost never intend indented code blocks (they use
  // fences), but they DO indent prose for style. If the chunk reads like
  // prose and nothing reads like code, parse it as normal content.
  const nonBlank = dedented.filter((l) => !isBlank(l.text));
  const codey = /[{};`]|=[^=]|<\/|::|->|=>|^\s*(def |class |function |return |import |from |const |let |var |if\s*\(|for\s*\(|while\s*\(|print\(|#include|SELECT |INSERT )/;
  const prosey = /^["'“(A-ZÀ-ɏ].{20,}[.!?:;,)"'”]$/;
  const anyCodey = nonBlank.some((l) => codey.test(l.text));
  const proseCount = nonBlank.filter((l) => prosey.test(l.text.trim())).length;

  if (!anyCodey && proseCount > 0 && proseCount >= Math.ceil(nonBlank.length / 2)) {
    diag.repair('indented-prose-not-code', 'Indented block reads as prose, not code; parsed as regular content', lines[start]!.lineNo);
    // Strip ALL the leading indent in one step. Peeling four columns at a time
    // and recursing costs one stack frame per four spaces, which a single long
    // over-indented line is enough to exhaust.
    const flat = chunk.map((l) => ({ text: l.text.trimStart(), lineNo: l.lineNo }));
    ctx.depth++;
    const inner = ctx.depth >= MAX_NESTING ? [] : parseBlocks(flat, ctx, false);
    ctx.depth--;
    if (inner.length > 0) {
      blocks.push(...inner);
    } else {
      blocks.push({
        type: 'paragraph',
        children: parseInlines(flat.map((l) => l.text).join('\n'), lines[start]!.lineNo, ctx),
        pos: { startLine: lines[start]!.lineNo, endLine: chunk[chunk.length - 1]!.lineNo },
      });
    }
    return end;
  }

  blocks.push({
    type: 'codeBlock',
    info: '',
    lang: '',
    value: dedented.map((l) => l.text).join('\n'),
    fenced: false,
    autoClosed: false,
    pos: { startLine: lines[start]!.lineNo, endLine: chunk[chunk.length - 1]!.lineNo },
  });
  return end;
}

function consumeBlockquote(lines: Line[], start: number, ctx: Ctx, blocks: Block[]): number {
  const n = lines.length;
  const inner: Line[] = [];
  let j = start;
  let lastWasMarkerOrLazy = false;
  let fenceParity = 0;

  // At the cap, stop peeling markers and keep the rest as literal text. This
  // bounds recursion on inputs like "> " repeated hundreds of times.
  if (ctx.depth >= MAX_NESTING) {
    for (; j < n && !isBlank(lines[j]!.text); j++) inner.push(lines[j]!);
    blocks.push({
      type: 'paragraph',
      children: parseInlines(inner.map((l) => l.text).join('\n'), lines[start]!.lineNo, ctx),
      pos: { startLine: lines[start]!.lineNo, endLine: lines[Math.max(j - 1, start)]!.lineNo },
    });
    return j;
  }

  for (; j < n; j++) {
    const t = lines[j]!.text;
    const m = /^ {0,3}> ?(.*)$/.exec(t);
    if (m) {
      const stripped = m[1]!;
      inner.push({ text: stripped, lineNo: lines[j]!.lineNo });
      if (matchBareFence(stripped) || matchFenceOpen(stripped)) fenceParity ^= 1;
      lastWasMarkerOrLazy = !isBlank(stripped);
      continue;
    }
    if (isBlank(t)) break;
    // Lazy continuation: a paragraph line that lost its '>' marker.
    if (lastWasMarkerOrLazy && fenceParity === 0 && !startsAnyBlock(t)) {
      inner.push({ text: t, lineNo: lines[j]!.lineNo });
      continue;
    }
    break;
  }

  // GitHub alert: the FIRST line of the quote is `[!WARNING]`. Anywhere else
  // the token is literal text the author is quoting.
  let alert: string | null = null;
  const firstInner = inner[0];
  if (firstInner !== undefined) {
    const am = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(firstInner.text.trim());
    if (am) {
      alert = am[1]!.toLowerCase();
      inner.shift();
      ctx.diag.note('extension-syntax', `GitHub alert "[!${am[1]!.toUpperCase()}]" recognized`, firstInner.lineNo);
    }
  }

  ctx.depth++;
  const children = parseBlocks(inner, ctx, false);
  ctx.depth--;
  blocks.push({
    type: 'blockquote',
    children,
    alert,
    pos: { startLine: lines[start]!.lineNo, endLine: lines[j - 1]!.lineNo },
  });
  return j;
}

/**
 * Pandoc-style definition list: a term line followed by one or more `: text`
 * lines. LLMs reach for this constantly in glossaries and API references.
 */
function consumeDefinitionList(lines: Line[], start: number, ctx: Ctx, blocks: Block[]): number {
  const n = lines.length;
  const items: DefinitionItem[] = [];
  let i = start;

  while (i < n) {
    const termLine = lines[i]!;
    if (isBlank(termLine.text)) break;
    if (i + 1 >= n || !/^ {0,3}:[ \t]+\S/.test(lines[i + 1]!.text)) break;

    const definitions: Inline[][] = [];
    let j = i + 1;
    for (; j < n; j++) {
      const dm = /^ {0,3}:[ \t]+(.*)$/.exec(lines[j]!.text);
      if (!dm) break;
      definitions.push(parseInlines(dm[1]!, lines[j]!.lineNo, ctx));
    }
    items.push({ term: parseInlines(termLine.text.trim(), termLine.lineNo, ctx), definitions });

    i = j;
    while (i < n && isBlank(lines[i]!.text)) i++;
  }

  if (items.length === 0) return start;
  ctx.diag.note('extension-syntax', 'Definition-list syntax recognized (term / ": definition")', lines[start]!.lineNo);
  blocks.push({
    type: 'definitionList',
    items,
    pos: { startLine: lines[start]!.lineNo, endLine: lines[Math.max(i - 1, start)]!.lineNo },
  });
  return i;
}

/** `:::note … :::` container, auto-closed at EOF if the model forgot the end. */
function consumeContainer(lines: Line[], start: number, open: { kind: string; title: string | null }, ctx: Ctx, blocks: Block[]): number {
  const n = lines.length;
  const inner: Line[] = [];
  let j = start + 1;
  let closed = false;
  let depth = 0;
  for (; j < n; j++) {
    const t = lines[j]!.text.trim();
    if (/^:{3,}\s*$/.test(t)) {
      if (depth === 0) {
        closed = true;
        break;
      }
      depth--;
      inner.push(lines[j]!);
      continue;
    }
    if (/^:{3,}[ \t]*[A-Za-z]/.test(t)) depth++;
    inner.push(lines[j]!);
  }
  if (!closed) {
    ctx.diag.repair('container-unclosed', `":::${open.kind}" container was never closed; auto-closed at end of input`, lines[start]!.lineNo);
  }
  ctx.depth++;
  const children = ctx.depth >= MAX_NESTING ? [] : parseBlocks(inner, ctx, false);
  if (ctx.depth >= MAX_NESTING) {
    ctx.diag.note('nesting-depth-capped', `Container nesting exceeded ${MAX_NESTING} levels; deeper content kept as text`, lines[start]!.lineNo);
  }
  ctx.depth--;
  blocks.push({
    type: 'container',
    kind: open.kind,
    title: open.title,
    children,
    pos: { startLine: lines[start]!.lineNo, endLine: lines[Math.min(j, n - 1)]!.lineNo },
  });
  return closed ? j + 1 : n;
}

function matchConfigBlock(lines: Line[], start: number, blocks: Block[]): number {
  const prev = blocks[blocks.length - 1];
  const introduced =
    prev !== undefined &&
    prev.type === 'paragraph' &&
    /:\s*$/.test(inlinePlainText(prev.children));
  if (!introduced) return -1;

  const isConfigLine = (t: string): boolean =>
    /^\s*\[[\w.$ -]+\]\s*$/.test(t) || /^\s*[\w.$-]+\s*=\s*\S/.test(t);

  let j = start;
  let count = 0;
  for (; j < lines.length; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) break;
    if (!isConfigLine(t)) return -1;
    count++;
  }
  return count >= 2 ? j : -1;
}

function consumeParagraph(lines: Line[], start: number, ctx: Ctx, blocks: Block[]): number {
  const { diag } = ctx;
  const n = lines.length;
  const para: Line[] = [lines[start]!];
  let j = start + 1;

  for (; j < n; j++) {
    const t = lines[j]!.text;
    if (isBlank(t)) break;
    if (ctx.refLines.has(lines[j]!.lineNo)) break;

    // Setext underline?
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(t);
    if (setext) {
      const char = setext[1]![0];
      const prev = para[para.length - 1]!;
      if (char === '=') {
        emitParagraphAsSetext(para, 1, lines[j]!, ctx, blocks);
        return j + 1;
      }
      // '-' is ambiguous: setext h2 vs thematic break. LLMs overwhelmingly
      // use --- as a separator, and a document that already uses ATX headings
      // is not going to switch conventions mid-way.
      // A setext title is short and label-like. A caption or timestamp
      // ("Report generated on 2026-08-07") is neither, and the dashes under it
      // are a divider.
      const prevText = prev.text.trim();
      const looksLikeTitle =
        para.length === 1 &&
        prevText.length <= 64 &&
        prevText.split(/\s+/).length <= 5 &&
        !/[.!?;,:]$/.test(prevText) &&
        !/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\b(19|20)\d{2}\b/.test(prevText) &&
        delimiterPipeCount(prevText) === 0;

      // In a document that otherwise uses ATX headings, a dash line is a
      // divider unless the line above is title-cased — "Benchmark Results" is
      // a section title; "Body A ends here" is the end of a paragraph.
      const accept = ctx.prefersThematicBreak ? looksLikeTitle && isTitleCased(prevText) : looksLikeTitle;
      if (accept) {
        if (setext[1]!.length >= 3) {
          diag.note('setext-vs-break-ambiguity', `Dashes under "${prevText.slice(0, 40)}" read as a setext heading (short title-like line)`, lines[j]!.lineNo);
        }
        emitParagraphAsSetext(para, 2, lines[j]!, ctx, blocks);
        return j + 1;
      }
      diag.repair(
        'setext-vs-break-ambiguity',
        ctx.prefersThematicBreak && looksLikeTitle
          ? 'Dashes treated as a thematic break: this document uses ATX headings throughout'
          : 'Dashes after a paragraph treated as a thematic break, not a setext heading',
        lines[j]!.lineNo,
      );
      flushParagraph(para, ctx, blocks);
      blocks.push({ type: 'thematicBreak', pos: { startLine: lines[j]!.lineNo, endLine: lines[j]!.lineNo } });
      return j + 1;
    }

    const next = j + 1 < n ? lines[j + 1]!.text : null;
    if (interruptsParagraph(t, next)) {
      if (isWeakRowCandidate(t) && next !== null && parseSeparatorRow(next)) {
        diag.note('table-interrupts-paragraph', 'Table starts directly after a paragraph with no blank line', lines[j]!.lineNo);
      }
      break;
    }
    para.push(lines[j]!);
  }

  flushParagraph(para, ctx, blocks);
  return j;
}

/** Words a title leaves lowercase; everything else should be capitalized. */
const TITLE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or',
  'per', 'the', 'to', 'via', 'vs', 'with',
]);

/** Is this line written in Title Case (or all caps) — i.e. does it read as a heading? */
function isTitleCased(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return false;
  if (text === text.toUpperCase()) return true; // ALL CAPS headings
  const significant = words.filter((w) => w.length >= 3 && !TITLE_SMALL_WORDS.has(w.toLowerCase()));
  if (significant.length === 0) return false;
  return significant.every((w) => /^[A-Z0-9"'([]/.test(w));
}

function emitParagraphAsSetext(para: Line[], depth: 1 | 2, underline: Line, ctx: Ctx, blocks: Block[]): void {
  const text = para.map((l) => l.text.trim()).join('\n');
  blocks.push({
    type: 'heading',
    depth,
    children: parseInlines(text, para[0]!.lineNo, ctx),
    setext: true,
    pos: { startLine: para[0]!.lineNo, endLine: underline.lineNo },
  });
}

/**
 * A paragraph that is nothing but one bold line — `**Section 2: Results**` —
 * is a section header the model wrote without using `#`. Promoting it lets
 * outline and table-of-contents extraction see the structure.
 *
 * Guarded so a bold lead-in ("**Note:** the API changed") or a fully bolded
 * sentence stays a paragraph: the line must be entirely inside one delimiter
 * pair, be short, and not read as a sentence.
 */
function boldHeadingText(para: Line[], mode: 'rule' | 'auto'): string | null {
  if (para.length !== 1) return null;
  const t = para[0]!.text.trim();
  const m = /^(\*\*\*|\*\*|__)(.+?)\1$/.exec(t);
  if (!m) return null;
  const inner = m[2]!.trim();
  if (inner === '' || inner.length > 80) return null;
  // A second delimiter pair inside means this is emphasised prose, not a title.
  if (/\*\*|__/.test(inner)) return null;
  // Sentence-ending punctuation (other than a trailing colon) means prose.
  if (/[.!?]$/.test(inner)) return null;
  if (inner.split(/\s+/).length > 12) return null;
  // A heading reads like a label, not like a sentence: it is title-cased, all
  // caps, ends with a colon, or is explicitly numbered. A bolded warning such
  // as `**Never deploy on a Friday**` is emphasis, and promoting it would
  // invent a section that the author never wrote.
  const labelLike =
    inner.endsWith(':') ||
    /^(step|section|phase|stage|part|chapter|appendix|note|summary|overview|conclusion)\b/i.test(inner) ||
    isTitleCased(inner);
  if (labelLike) return inner;

  // The rule above is blind outside ASCII-title-cased text: Chinese, Japanese,
  // Korean and Arabic have no letter case at all, so it can never fire, and a
  // section header in those scripts was silently demoted to a paragraph. Where
  // its signal does not apply, defer to the classifier, which was fitted on
  // real headings across scripts. Where the signal DOES apply the rule keeps
  // the last word, because it is measurably more precise there.
  if (mode !== 'rule' && !ruleSignalApplies(inner)) {
    const decided = isHeadingByModel({
      text: inner,
      delimiter: m[1] as '**' | '__' | '***',
      docUsesAtx: false,
      siblingBoldLines: 0,
      followedByBlank: true,
      followedByParagraph: true,
      relativePosition: 0,
    });
    if (decided === true) return inner;
  }
  return null;
}

function flushParagraph(para: Line[], ctx: Ctx, blocks: Block[]): void {
  const bold = ctx.options.promoteBoldHeadings ? boldHeadingText(para, ctx.options.headingDetection) : null;
  if (bold !== null) {
    ctx.diag.repair('bold-line-heading', `Bold-only line "${bold.slice(0, 40)}" promoted to a heading`, para[0]!.lineNo);
    blocks.push({
      type: 'heading',
      depth: 3,
      children: parseInlines(bold, para[0]!.lineNo, ctx),
      setext: false,
      pos: { startLine: para[0]!.lineNo, endLine: para[0]!.lineNo },
    });
    return;
  }
  const text = para.map((l) => l.text.replace(/^ +/, '')).join('\n');
  blocks.push({
    type: 'paragraph',
    children: parseInlines(text, para[0]!.lineNo, ctx),
    pos: { startLine: para[0]!.lineNo, endLine: para[para.length - 1]!.lineNo },
  });
}
