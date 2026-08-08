import type { Inline, Link, Text } from './types.js';
import type { Ctx } from './context.js';
import { useFootnote } from './context.js';
import type { BracketTok, Tok } from './inline-tokens.js';
import { assemble, inlinePlainText, isPunct, isWs, plainTextOf, text } from './inline-tokens.js';
import {
  dropOrphanDelimiters,
  dropTrailingDeadDelimiter,
  foldHtmlSpans,
  processEmphasis,
  recoverSpacePadded,
  recoverSpeciesMismatch,
  recoverTildeMismatch,
  recoverUnclosed,
  splitCrossingRanges,
} from './inline-recovery.js';

export { inlinePlainText };

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', times: '×', divide: '÷', ne: '≠', le: '≤', ge: '≥',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°', plusmn: '±', middot: '·', bull: '•',
};

/**
 * HTML tags whose meaning is exactly a markdown inline node. Mapping them onto
 * native nodes (rather than raw htmlInline) keeps the AST uniform for callers
 * that walk it — `<b>x</b>` and `**x**` should not need two code paths.
 */
const HTML_SPAN_MAP: Record<string, 'strong' | 'emphasis' | 'delete'> = {
  b: 'strong',
  strong: 'strong',
  i: 'emphasis',
  em: 'emphasis',
  del: 'delete',
  s: 'delete',
  strike: 'delete',
};

/**
 * A URL shape confident enough to drive a structural repair (synthesizing a
 * missing `]`, `(` or `)`). Deliberately stricter than the `urlish` test used
 * for a destination that already sits inside well-formed `(...)`.
 */
const STRONG_URL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/{1,3}[^\s<>]|www\.[^\s<>])/;
const STRONG_URL_RUN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/{1,3}[^\s<>]+|www\.[^\s<>]+)/;

/**
 * Function words that mark the end of a shell command / identifier and the
 * start of English prose. Used only to bound an ALREADY-BROKEN code span, so a
 * false positive shortens a repair rather than inventing one.
 */
const PROSE_STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'then', 'to', 'in', 'into', 'on', 'onto', 'for', 'with',
  'without', 'which', 'that', 'this', 'these', 'those', 'from', 'of', 'is', 'are', 'was', 'were',
  'be', 'been', 'will', 'would', 'should', 'shall', 'can', 'could', 'if', 'when', 'while', 'after',
  'before', 'so', 'as', 'at', 'by', 'it', 'its', 'you', 'your', 'we', 'our', 'they', 'their',
  'must', 'may', 'not', 'does', 'did', 'has', 'have', 'had', 'because', 'unless', 'until', 'via',
]);

const SMART_QUOTES = /[‘’“”]/;

const INLINE_HTML_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img',
  'input', 'ins', 'kbd', 'label', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'big', 'font', 'center', 'details',
  'summary', 'div', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'iframe', 'video', 'audio', 'source',
]);

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function parseInlines(src: string, startLine: number, ctx: Ctx): Inline[] {
  if (src === '') return [];
  const toks = scan(src, startLine, ctx);
  return finalize(toks, ctx);
}

function finalize(toks: Tok[], ctx: Ctx): Inline[] {
  const auto = ctx.options.inlineRecovery === 'auto';
  foldHtmlSpans(toks, ctx, finalize);
  // Bounded: each split adds two tokens, so the cap keeps the pass linear.
  if (auto) for (let n = 0; n < 8 && splitCrossingRanges(toks, ctx); n++);
  processEmphasis(toks);
  if (auto) {
    dropOrphanDelimiters(toks, ctx);
    recoverSpacePadded(toks, ctx);
    recoverSpeciesMismatch(toks, ctx);
    recoverTildeMismatch(toks, ctx);
    recoverUnclosed(toks, ctx);
    dropTrailingDeadDelimiter(toks, ctx);
  }
  return assemble(toks);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function scan(s: string, startLine: number, ctx: Ctx): Tok[] {
  const { diag } = ctx;
  const math = ctx.options.math;
  const toks: Tok[] = [];
  const brackets: number[] = []; // indices into toks
  let pos = 0;
  let line = startLine;
  let buf = '';
  let seq = 0;

  const flush = () => {
    if (buf !== '') {
      toks.push(text(buf));
      buf = '';
    }
  };

  // Memoized: the scanner only moves forward, so once the end of the current
  // line is known it stays valid until `from` passes it. Without this, each
  // call rescans the rest of the line, which is quadratic on a long one.
  let lineEndCache = -1;
  const lineEnd = (from: number): number => {
    if (from <= lineEndCache) return lineEndCache;
    const nl = s.indexOf('\n', from);
    lineEndCache = nl === -1 ? s.length : nl;
    return lineEndCache;
  };

  while (pos < s.length) {
    const ch = s[pos]!;

    // ---- newline: soft/hard break ----
    if (ch === '\n') {
      if (buf.endsWith('\\')) {
        buf = buf.slice(0, -1);
        flush();
        toks.push({ kind: 'node', node: { type: 'hardBreak' } });
      } else if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        toks.push({ kind: 'node', node: { type: 'hardBreak' } });
      } else {
        buf = buf.replace(/ +$/, '');
        flush();
        toks.push({ kind: 'node', node: { type: 'softBreak' } });
      }
      line++;
      pos++;
      continue;
    }

    // ---- backslash escapes & LaTeX math delimiters ----
    if (ch === '\\') {
      const next = s[pos + 1];
      if (math && (next === '(' || next === '[')) {
        const closer = next === '(' ? '\\)' : '\\]';
        const end = s.indexOf(closer, pos + 2);
        flush();
        if (end !== -1) {
          toks.push({ kind: 'node', node: { type: 'inlineMath', value: s.slice(pos + 2, end).trim() } });
          line += countNl(s, pos, end);
          pos = end + 2;
        } else {
          const le = lineEnd(pos);
          diag.repair('math-auto-closed', `Inline math '\\${next}' was never closed; auto-closed at end of line`, line);
          toks.push({ kind: 'node', node: { type: 'inlineMath', value: s.slice(pos + 2, le).trim() } });
          pos = le;
        }
        continue;
      }
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        buf += next;
        pos += 2;
        continue;
      }
      buf += '\\';
      pos++;
      continue;
    }

    // ---- code spans ----
    if (ch === '`') {
      let run = 1;
      while (s[pos + run] === '`') run++;
      const closer = '`'.repeat(run);
      let search = pos + run;
      let end = -1;
      // Find a backtick run of exactly the same length.
      while (search < s.length) {
        const idx = s.indexOf(closer, search);
        if (idx === -1) break;
        let extra = idx + run;
        while (s[extra] === '`') extra++;
        if (extra - idx === run) {
          end = idx;
          break;
        }
        search = extra;
      }
      if (end !== -1) {
        // `` `cmd `arg`` `` — the author opened with one backtick but closed
        // with two because the content itself contains a backtick. Honor the
        // wider span instead of splitting the sentence into code/prose confetti.
        if (ctx.options.inlineRecovery === 'auto' && run === 1) {
          const wider = nestedBacktickClose(s, pos, lineEnd(pos));
          if (wider !== -1 && wider > end) {
            diag.repair(
              'code-span-nested-backtick',
              'Code span opened with one backtick and closed with two; treated the interior backticks as content',
              line,
            );
            end = wider;
          }
        }
        let content = s.slice(pos + run, end).replace(/\n/g, ' ');
        if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flush();
        noteSmartQuotes(content, line, ctx);
        toks.push({ kind: 'node', node: { type: 'inlineCode', value: content } });
        line += countNl(s, pos, end);
        pos = end + run;
        continue;
      }
      // Recovery: unmatched backtick that opens something code-ish → close at
      // the code/prose boundary (or end of line if the whole remainder reads as
      // code). `don`t` style apostrophe misuse stays literal.
      const prev = s[pos - 1];
      const after = s[pos + run];
      const le = lineEnd(pos + run);
      const restOfLine = s.slice(pos + run, le);
      if (
        ctx.options.inlineRecovery === 'auto' &&
        run <= 2 &&
        !isWs(after) &&
        restOfLine.trim() !== '' &&
        !(prev !== undefined && /\w/.test(prev) && after !== undefined && /\w/.test(after))
      ) {
        const cut = codeProseBoundary(restOfLine);
        // Keep the separating whitespace outside the span so the prose that
        // follows does not run into the closing </code>.
        const head = restOfLine.slice(0, cut).replace(/\s+$/, '');
        const value = head.trim();
        if (value !== '') {
          flush();
          diag.repair(
            'code-span-auto-closed',
            cut < restOfLine.length
              ? 'Unclosed inline code backtick auto-closed where the code ends and prose resumes'
              : 'Unclosed inline code backtick auto-closed at end of line',
            line,
          );
          noteSmartQuotes(value, line, ctx);
          toks.push({ kind: 'node', node: { type: 'inlineCode', value } });
          pos = pos + run + head.length;
          continue;
        }
      }
      buf += closer;
      pos += run;
      continue;
    }

    // ---- inline math: $...$ and $$...$$ ----
    if (math && ch === '$') {
      if (s[pos + 1] === '$') {
        const end = s.indexOf('$$', pos + 2);
        if (end !== -1 && s.slice(pos + 2, end).trim() !== '') {
          flush();
          toks.push({ kind: 'node', node: { type: 'inlineMath', value: s.slice(pos + 2, end).trim() } });
          line += countNl(s, pos, end);
          pos = end + 2;
          continue;
        }
        // `$$ ... $` — opened with two, closed with one. Only believed when the
        // body carries TeX markers, so "$$5 to $10" stays currency.
        if (ctx.options.inlineRecovery === 'auto') {
          const le = lineEnd(pos + 2);
          const single = s.indexOf('$', pos + 2);
          if (single !== -1 && single < le) {
            const body = s.slice(pos + 2, single).trim();
            if (body !== '' && /[\\^_{}=]/.test(body)) {
              flush();
              diag.repair('math-auto-closed', "Inline math opened with '$$' but closed with a single '$'", line);
              toks.push({ kind: 'node', node: { type: 'inlineMath', value: body } });
              pos = single + 1;
              continue;
            }
          }
        }
        buf += '$$';
        pos += 2;
        continue;
      }
      const after = s[pos + 1];
      if (!isWs(after) && after !== '$') {
        // find closing $ on the same line, not preceded by space, not followed by digit
        // Bounded: real inline math is short, and scanning to end of line for
        // every `$` makes a line of dollar amounts ("costs $5 or $10 …") O(n^2).
        const le = Math.min(lineEnd(pos + 1), pos + 1 + 512);
        let end = -1;
        for (let k = pos + 1; k < le; k++) {
          if (s[k] === '$' && !isWs(s[k - 1]) && !(s[k + 1] !== undefined && /\d/.test(s[k + 1]!))) {
            end = k;
            break;
          }
        }
        if (end !== -1) {
          const content = s.slice(pos + 1, end);
          // Currency guard: "$5" / "$1,299.99" is money, not math.
          if (!/^[\d.,]+$/.test(content)) {
            flush();
            toks.push({ kind: 'node', node: { type: 'inlineMath', value: content } });
            pos = end + 1;
            continue;
          }
        }
      }
      buf += '$';
      pos++;
      continue;
    }

    // ---- angle constructs: autolinks, inline HTML ----
    if (ch === '<') {
      const rest = s.slice(pos);
      let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
      if (m) {
        flush();
        toks.push({ kind: 'node', node: { type: 'link', url: m[1]!, title: null, children: [{ type: 'text', value: m[1]! }] } });
        pos += m[0].length;
        continue;
      }
      m = /^<([^\s<>@]+@[^\s<>]+\.[^\s<>]+)>/.exec(rest);
      if (m) {
        flush();
        toks.push({ kind: 'node', node: { type: 'link', url: 'mailto:' + m[1]!, title: null, children: [{ type: 'text', value: m[1]! }] } });
        pos += m[0].length;
        continue;
      }
      if (rest.startsWith('<!--')) {
        const end = s.indexOf('-->', pos + 4);
        if (end !== -1) {
          flush();
          toks.push({ kind: 'node', node: { type: 'htmlInline', value: s.slice(pos, end + 3) } });
          line += countNl(s, pos, end);
          pos = end + 3;
          continue;
        }
      }
      m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?(\/?)>/.exec(rest);
      if (m && INLINE_HTML_TAGS.has(m[2]!.toLowerCase())) {
        const tag = m[2]!.toLowerCase();
        const closing = m[1] === '/';
        flush();
        if (!closing && tag === 'br') {
          toks.push({ kind: 'node', node: { type: 'hardBreak' } });
          pos += m[0].length;
          continue;
        }
        const mapped = HTML_SPAN_MAP[tag];
        if (mapped !== undefined && m[4] !== '/') {
          toks.push({ kind: 'htmlSpan', closing, tag, node: mapped, raw: m[0], used: false, line });
          pos += m[0].length;
          continue;
        }
        toks.push({ kind: 'node', node: { type: 'htmlInline', value: m[0] } });
        pos += m[0].length;
        continue;
      }
      // Unknown/pseudo tag (<thinking>, <placeholder>…) → literal text so the
      // reader can see it. The renderer escapes it.
      buf += '<';
      pos++;
      continue;
    }

    // ---- bare URL autolinks ----
    if ((ch === 'h' || ch === 'w') && (pos === 0 || !/[\w./-]/.test(s[pos - 1]!))) {
      const rest = s.slice(pos);
      const m = /^(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/.exec(rest);
      if (m) {
        let url = m[1]!;
        // A ']' cannot belong to a URL that sits inside an open '[': it is the
        // link-text terminator, and swallowing it would hide the bracket from
        // the repair passes below.
        if (brackets.length > 0) {
          const rb = url.indexOf(']');
          if (rb !== -1) url = url.slice(0, rb);
        }
        // Trim trailing punctuation that belongs to the sentence.
        for (;;) {
          const last = url[url.length - 1]!;
          if (/[.,;:!?'"”’*_~]/.test(last)) {
            url = url.slice(0, -1);
            continue;
          }
          if (last === ')') {
            const opens = (url.match(/\(/g) ?? []).length;
            const closes = (url.match(/\)/g) ?? []).length;
            if (closes > opens) {
              url = url.slice(0, -1);
              continue;
            }
          }
          break;
        }
        if (url.length > (url.startsWith('www.') ? 4 : 8)) {
          flush();
          const href = url.startsWith('www.') ? 'http://' + url : url;
          toks.push({ kind: 'node', node: { type: 'link', url: href, title: null, children: [{ type: 'text', value: url }] } });
          pos += url.length;
          continue;
        }
      }
    }

    // ---- footnote reference [^1] ----
    if (ch === '[' && s[pos + 1] === '^') {
      const close = s.indexOf(']', pos + 2);
      const label = close === -1 ? '' : s.slice(pos + 2, close);
      if (close !== -1 && label !== '' && !/[\s[\]^]/.test(label)) {
        flush();
        toks.push({
          kind: 'node',
          node: { type: 'footnoteRef', label, index: useFootnote(ctx, label) },
        });
        pos = close + 1;
        continue;
      }
    }

    // ---- images / brackets ----
    if (ch === '!' && s[pos + 1] === '[') {
      flush();
      toks.push({ kind: 'bracket', image: true, active: true, line });
      brackets.push(toks.length - 1);
      pos += 2;
      continue;
    }
    // `! [alt](url)` — a stray space between the bang and the bracket. Only
    // when the bang stands alone, so "Nice! [see here](url)" stays a link.
    if (ch === '!' && ctx.options.inlineRecovery === 'auto' && isWs(s[pos - 1])) {
      const sp = /^![ \t]{1,3}\[/.exec(s.slice(pos, pos + 6));
      if (sp) {
        flush();
        diag.repair('image-space-before-bracket', "Image '!' was separated from its '[' by spaces", line);
        toks.push({ kind: 'bracket', image: true, active: true, line });
        brackets.push(toks.length - 1);
        pos += sp[0].length;
        continue;
      }
    }
    if (ch === '[') {
      // `[!alt](url)` — the bang landed inside the brackets. Requires a real
      // destination, so the GitHub admonition marker `[!NOTE]` is untouched.
      if (ctx.options.inlineRecovery === 'auto' && s[pos + 1] === '!') {
        const bang = /^\[![ \t]?[^\][\n]{1,200}\][ \t]{0,2}\(/.exec(s.slice(pos, pos + 260));
        if (bang) {
          flush();
          diag.repair('image-transposed-bang', "Image '!' was written inside the brackets as '[!alt]'", line);
          toks.push({ kind: 'bracket', image: true, active: true, line });
          brackets.push(toks.length - 1);
          pos += 2;
          continue;
        }
      }
      flush();
      toks.push({ kind: 'bracket', image: false, active: true, line });
      brackets.push(toks.length - 1);
      pos += 1;
      continue;
    }
    // `[text(url)` — the ']' was never typed. Only fires with an open bracket
    // and an unmistakable URL, so "[see note (here)]" stays literal.
    if (
      ch === '(' &&
      ctx.options.inlineRecovery === 'auto' &&
      brackets.length > 0 &&
      STRONG_URL.test(s.slice(pos + 1, pos + 64))
    ) {
      flush();
      const bi = topActiveBracket(toks, brackets);
      if (bi !== -1 && toks.length > bi + 1) {
        const dest = parseDestination(s, pos, line, ctx, false);
        if (dest !== null && STRONG_URL.test(dest.url)) {
          const open = toks[bi] as BracketTok;
          brackets.pop();
          diag.repair('link-missing-bracket', "Link text was never closed with ']'; inferred it before the URL", line);
          buildLinkNode(toks, bi, open, dest.url, dest.title, brackets, ctx);
          pos = dest.end;
          continue;
        }
      }
    }
    if (ch === ']') {
      flush();
      const resolved = tryCloseBracket(s, pos, toks, brackets, line, ctx);
      if (resolved !== -1) {
        pos = resolved;
        continue;
      }
      buf += ']';
      pos++;
      continue;
    }

    // ---- ==highlight== ----
    // Handled as a whole construct rather than through the delimiter stack:
    // `a == b` and `x==y` must stay literal, and requiring a same-line closer
    // with non-space content right after the opener gives exactly that.
    if (ch === '=' && s[pos + 1] === '=' && !isWs(s[pos + 2]) && s[pos + 2] !== '=') {
      const le = lineEnd(pos);
      const end = s.indexOf('==', pos + 2);
      if (end !== -1 && end < le && !isWs(s[end - 1])) {
        flush();
        toks.push({
          kind: 'node',
          node: { type: 'mark', children: parseInlines(s.slice(pos + 2, end), line, ctx) },
        });
        pos = end + 2;
        continue;
      }
    }

    // ---- emphasis / strikethrough delimiters ----
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (s[pos + run] === ch) run++;
      const before = s[pos - 1];
      const after = s[pos + run];
      const leftFlank = !isWs(after) && !(isPunct(after) && !isWs(before) && !isPunct(before));
      const rightFlank = !isWs(before) && !(isPunct(before) && !isWs(after) && !isPunct(after));
      let canOpen: boolean;
      let canClose: boolean;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunct(before));
        canClose = rightFlank && (!leftFlank || isPunct(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      if (ch === '~' && run !== 2) {
        buf += ch.repeat(run);
        pos += run;
        continue;
      }
      flush();
      toks.push({
        kind: 'delim', char: ch, count: run, origCount: run, canOpen, canClose,
        spaceAfter: isWs(after), spaceBefore: isWs(before),
        nextIsWord: after !== undefined && /[\p{L}\p{N}]/u.test(after),
        prevIsDigit: before !== undefined && /\d/.test(before),
        prevWord: wordBefore(s, pos),
        nextWord: wordAfter(s, pos + run),
        line, seq: seq++,
      });
      pos += run;
      continue;
    }

    // ---- entities ----
    if (ch === '&') {
      const m = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(pos));
      if (m) {
        const body = m[1]!;
        if (body.startsWith('#')) {
          const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          try {
            buf += cp === 0 ? '�' : String.fromCodePoint(cp);
          } catch {
            buf += '�';
          }
          pos += m[0].length;
          continue;
        }
        const decoded = ENTITIES[body];
        if (decoded !== undefined) {
          buf += decoded;
          pos += m[0].length;
          continue;
        }
      }
      buf += '&';
      pos++;
      continue;
    }

    buf += ch;
    pos++;
  }

  flush();
  return toks;
}

function countNl(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s[i] === '\n') n++;
  return n;
}

/** Bounded look-behind for the whitespace-delimited word before `pos`. */
function wordBefore(s: string, pos: number): string {
  let i = pos;
  // Allow the run to be separated from its word by a single space (padding).
  if (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  const end = i;
  const floor = Math.max(0, end - 48);
  while (i > floor && !isWs(s[i - 1])) i--;
  return s.slice(i, end);
}

/** Bounded look-ahead for the whitespace-delimited word after `pos`. */
function wordAfter(s: string, pos: number): string {
  let i = pos;
  if (s[i] === ' ' || s[i] === '\t') i++;
  const start = i;
  const ceil = Math.min(s.length, start + 48);
  while (i < ceil && !isWs(s[i])) i++;
  return s.slice(start, i);
}


/**
 * `` `X`Y`` `` — a single-backtick opener closed by a double. Returns the index
 * of the closing backtick to use, or -1. Requires the exact shape (one interior
 * run of one backtick, then a final run of exactly two ending the line's
 * backticks) so that `` `ls -la` in backticks: … `` keeps its normal pairing.
 */
function nestedBacktickClose(s: string, openPos: number, le: number): number {
  let i = openPos + 1;
  let interiorRuns = 0;
  let firstLen = 0;
  let lastStart = -1;
  let lastLen = 0;
  while (i < le) {
    if (s[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (j < le && s[j] === '`') j++;
    if (lastStart === -1) firstLen = j - i;
    else interiorRuns += 1;
    lastStart = i;
    lastLen = j - i;
    if (interiorRuns > 1) return -1;
    i = j;
  }
  // Exactly `X`Y``: one interior single backtick, then a final run of two.
  if (interiorRuns !== 1 || firstLen !== 1 || lastLen !== 2) return -1;
  return lastStart + 1;
}

/**
 * Where an unterminated code span stops looking like code and starts reading as
 * prose. Returns an offset into `rest` (its full length when it is all code).
 */
function codeProseBoundary(rest: string): number {
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let tokens = 0;
  while ((m = re.exec(rest)) !== null) {
    const word = m[0].replace(/^[([{'"]+|[)\]}'",.;:!?]+$/g, '').toLowerCase();
    if (tokens > 0 && PROSE_STOPWORDS.has(word)) return m.index;
    tokens++;
    if (tokens > 200) break;
  }
  return rest.length;
}

function noteSmartQuotes(content: string, line: number, ctx: Ctx): void {
  if (!SMART_QUOTES.test(content)) return;
  ctx.diag.note(
    'code-span-smart-quotes',
    'Code span contains typographic (curly) quotes; they will not match straight quotes at runtime',
    line,
  );
}

/** Top-of-stack active bracket, discarding deactivated entries. */
function topActiveBracket(toks: Tok[], brackets: number[]): number {
  while (brackets.length > 0) {
    const idx = brackets[brackets.length - 1]!;
    const tok = toks[idx];
    if (tok !== undefined && tok.kind === 'bracket') {
      if (tok.active) return idx;
      brackets.pop();
      continue;
    }
    brackets.pop();
  }
  return -1;
}

/** Strip sentence punctuation that a bare URL should not have absorbed. */
function trimUrlTail(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) break;
    if (/[.,;:!?'"”’*_~]/.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Returns the new scan position, or -1 if the ']' resolves to nothing. */
function tryCloseBracket(s: string, pos: number, toks: Tok[], brackets: number[], line: number, ctx: Ctx): number {
  const { diag } = ctx;
  // Find the most recent active bracket.
  let bi = -1;
  while (brackets.length > 0) {
    const idx = brackets[brackets.length - 1]!;
    const tok = toks[idx];
    if (tok !== undefined && tok.kind === 'bracket') {
      if (tok.active) {
        bi = idx;
        break;
      }
      brackets.pop(); // inactive → discard and keep looking
      continue;
    }
    brackets.pop();
  }
  if (bi === -1) return -1;
  const open = toks[bi] as BracketTok;

  let after = pos + 1;
  let dest: { url: string; title: string | null; end: number } | null = null;

  // Inline destination: "(...)", tolerating spaces between ] and ( when the
  // content is URL-shaped.
  if (s[after] === '(') {
    dest = parseDestination(s, after, line, ctx, false);
  } else {
    // Bounded slice: the pattern can match at most 4 characters, and slicing
    // the whole tail here once per `]` made bracket-heavy input quadratic.
    const sp = /^[ \t]{1,3}\(/.exec(s.slice(after, after + 4));
    if (sp) {
      const cand = parseDestination(s, after + sp[0].length - 1, line, ctx, true);
      if (cand) {
        diag.repair('link-space-before-paren', 'Link text and URL were separated by spaces', line);
        dest = cand;
      }
    }
  }

  if (dest) {
    brackets.pop();
    buildLinkNode(toks, bi, open, dest.url, dest.title, brackets, ctx);
    return dest.end;
  }

  const auto = ctx.options.inlineRecovery === 'auto';

  // Full/collapsed reference: [text][label] or [text][]. The label slice is
  // bounded, so this stays O(1) per ']'.
  const refm = /^\[([^\]\n]{0,400})\]/.exec(s.slice(pos + 1, pos + 403));
  if (refm) {
    const explicit = refm[1]!.trim();
    const linkText = plainTextOf(toks, bi + 1, 400);
    const label = explicit === '' ? linkText : explicit;
    const end = pos + 1 + refm[0].length;
    const ref = ctx.refs.get(normalizeLabel(label));
    if (ref) {
      brackets.pop();
      buildLinkNode(toks, bi, open, ref.url, ref.title, brackets, ctx);
      return end;
    }
    // The definition never arrived. Showing `[text][label]` raw is the one
    // outcome nobody wants; keep the text and drop the bracket debris. Held to
    // link-text-shaped content so `matrix[i][j]` is left alone.
    if (auto && /\p{L}/u.test(linkText) && (/\s/.test(linkText.trim()) || linkText.trim().length >= 4)) {
      brackets.pop();
      diag.repair(
        'link-ref-undefined',
        `Reference link label '${label}' has no definition; kept the link text and dropped the brackets`,
        line,
      );
      toks.splice(bi, 1);
      return end;
    }
  }

  // Shortcut reference [text] — only meaningful when definitions exist.
  if (ctx.refs.size > 0) {
    const ref = ctx.refs.get(normalizeLabel(plainTextOf(toks, bi + 1, 400)));
    if (ref) {
      brackets.pop();
      buildLinkNode(toks, bi, open, ref.url, ref.title, brackets, ctx);
      return pos + 1;
    }
  }

  if (auto && toks.length > bi + 1) {
    // `[text]https://…` — the parentheses were never typed.
    // The one-character guard matters: without it, every `]` in bracket-heavy
    // input copies a 2KB slice, which is quadratic overall.
    const bare = /[a-zA-Z]/.test(s[pos + 1] ?? '') ? STRONG_URL_RUN.exec(s.slice(pos + 1, pos + 2049)) : null;
    if (bare) {
      const url = trimUrlTail(bare[0]);
      if (url.length > (url.startsWith('www.') ? 4 : 8)) {
        brackets.pop();
        diag.repair('link-missing-parens', "A bare URL followed ']' with no parentheses; treated it as the destination", line);
        buildLinkNode(toks, bi, open, url.startsWith('www.') ? 'http://' + url : url, null, brackets, ctx);
        return pos + 1 + url.length;
      }
    }

    // `(text)[url]` — the two halves were typed in the wrong order. Requires
    // the bracket half to be a bare URL and the paren half to touch it, so an
    // ordinary parenthetical followed by brackets is untouched.
    // Check the cheap side first: this only applies when the text right before
    // the `[` ends in `)`, so testing that avoids flattening the bracket
    // contents on every `]`.
    const prev = toks[bi - 1];
    const transposable =
      !open.image &&
      prev !== undefined &&
      prev.kind === 'node' &&
      prev.node.type === 'text' &&
      prev.node.value.endsWith(')');
    if (transposable) {
      const innerText = plainTextOf(toks, bi + 1, 2048).trim();
      if (
        innerText !== '' &&
        !/\s/.test(innerText) &&
        STRONG_URL.test(innerText) &&
        prev !== undefined &&
        prev.kind === 'node' &&
        prev.node.type === 'text'
      ) {
        const openIdx = prev.node.value.lastIndexOf('(');
        const label = openIdx === -1 ? '' : prev.node.value.slice(openIdx + 1, -1);
        if (openIdx !== -1 && label.trim() !== '' && !/[()[\]]/.test(label)) {
          brackets.pop();
          diag.repair('link-transposed', 'Link text and URL were transposed as (text)[url]', line);
          prev.node.value = prev.node.value.slice(0, openIdx);
          toks.length = bi;
          toks.push({
            kind: 'node',
            node: { type: 'link', url: innerText, title: null, children: [{ type: 'text', value: label }] },
          });
          return pos + 1;
        }
      }
    }
  }

  // No destination: the bracket pair is literal. Keep text, drop the bracket
  // from the stack.
  brackets.pop();
  return -1;
}

function parseDestination(
  s: string,
  parenPos: number,
  line: number,
  ctx: Ctx,
  requireUrlish: boolean,
): { url: string; title: string | null; end: number } | null {
  const { diag } = ctx;
  let i = parenPos + 1;
  while (s[i] === ' ') i++;

  // Bound every scan below: a destination cannot be longer than this, and an
  // unbounded indexOf here costs O(line length) per `]`, which made a long
  // single line of links quadratic.
  const MAX_URL = 2048;
  const windowEnd = Math.min(s.length, i + MAX_URL);

  // <angle destination>
  if (s[i] === '<') {
    const close = s.indexOf('>', i + 1);
    if (close !== -1 && close < windowEnd && !s.slice(i + 1, close).includes('\n')) {
      let j = close + 1;
      const t = parseTitle(s, j);
      j = t.end;
      while (s[j] === ' ') j++;
      if (s[j] === ')') return { url: s.slice(i + 1, close), title: t.title, end: j + 1 };
    }
  }

  // The loop breaks on a newline itself, so no pre-scan for one is needed.
  const lineLimit = windowEnd;
  let depth = 0;
  let j = i;
  let sawSpace = false;
  let url = '';
  let title: string | null = null;

  while (j < lineLimit) {
    const ch = s[j]!;
    if (ch === '\n') break;
    if (ch === '\\' && j + 1 < lineLimit) {
      url += s[j + 1]!;
      j += 2;
      continue;
    }
    // Unescaped brackets cannot appear in a bare destination — stopping here
    // is both correct and what bounds the scan on bracket-heavy input.
    if (ch === '[' || ch === ']') break;
    if (ch === '(') depth++;
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (ch === ' ' || ch === '\t') {
      // Might be the separator before a "title", or a URL containing spaces.
      const t = parseTitle(s, j);
      if (t.title !== null) {
        let k = t.end;
        while (s[k] === ' ') k++;
        if (s[k] === ')') {
          title = t.title;
          j = k;
          break;
        }
      }
      sawSpace = true;
      url += ch;
      j++;
      continue;
    }
    url += ch;
    j++;
  }

  url = url.trim();
  if (url === '') return null;

  const urlish = /^(https?:|mailto:|ftp:|\/|\.\/|\.\.\/|#|www\.)/i.test(url) || (/[./#:]/.test(url) && !/\s{2,}/.test(url));

  if (j < lineLimit && s[j] === ')') {
    if (sawSpace) {
      if (requireUrlish || !urlish) {
        // "[text] (see note)" — prose parens, not a link.
        if (!urlish) return null;
      }
      diag.repair('link-url-spaces', 'Link URL contains spaces; captured through the closing parenthesis', line);
    }
    return { url, title, end: j + 1 };
  }

  // Unclosed "(url" — take what we have if it looks like a URL.
  if (!sawSpace && urlish) {
    diag.repair('link-unclosed', 'Link URL was never closed with ")"; captured to end of line', line);
    return { url, title: null, end: j };
  }
  return null;
}

function parseTitle(s: string, from: number): { title: string | null; end: number } {
  let i = from;
  while (s[i] === ' ' || s[i] === '\t') i++;
  const q = s[i];
  if (q !== '"' && q !== "'") return { title: null, end: from };
  const close = s.indexOf(q, i + 1);
  if (close === -1 || s.slice(i, close).includes('\n')) return { title: null, end: from };
  return { title: s.slice(i + 1, close), end: close + 1 };
}

function buildLinkNode(toks: Tok[], bi: number, open: BracketTok, url: string, title: string | null, brackets: number[], ctx: Ctx): void {
  const inner = toks.slice(bi + 1);
  const children = finalize(inner, ctx);
  let node: Inline;
  if (open.image) {
    node = { type: 'image', url, title, alt: inlinePlainText(children) };
  } else {
    node = { type: 'link', url, title, children };
    // Links can't nest: deactivate earlier '[' openers.
    for (const idx of brackets) {
      const t = toks[idx];
      if (t !== undefined && t.kind === 'bracket' && !t.image) t.active = false;
    }
  }
  toks.length = bi;
  toks.push({ kind: 'node', node });
}



function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Emphasis resolution (CommonMark delimiter algorithm)
// ---------------------------------------------------------------------------

export function linkNodeIsLink(node: Inline): node is Link {
  return node.type === 'link';
}

// Type guard helper kept local to satisfy imports.
export function textNode(value: string): Text {
  return { type: 'text', value };
}
