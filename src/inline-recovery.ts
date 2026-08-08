/**
 * Emphasis resolution and the inline repair passes.
 *
 * `processEmphasis` is CommonMark's delimiter algorithm, unchanged. Everything
 * after it exists because LLM output routinely leaves delimiters dangling,
 * padded, crossed, or of the wrong species. Each pass is deliberately narrow,
 * and each is bounded so pathological input stays near-linear: a pass that
 * scans the whole token list per token would be quadratic, so they rebuild the
 * list in one sweep rather than splicing repeatedly.
 */
import type { Inline } from './types.js';
import type { Ctx } from './context.js';
import type { DelimTok, NodeTok, Tok } from './inline-tokens.js';
import { assemble, isBreakTok, isPunct, isWs, text, trimEdgeSpaces } from './inline-tokens.js';

/**
 * Deepest inline nesting we will build. Inline nodes are walked recursively by
 * the renderer and by any consumer, so the tree has to stay within a call
 * stack. No real document nests emphasis anywhere near this far.
 */
const MAX_INLINE_NESTING = 48;

const NUMERIC_OPERAND = /^[(]*[-+]?\d[\d_.,]*[)]*$/;

export function processEmphasis(toks: Tok[]): void {
  let c = 0;
  let guard = 0;
  const maxIter = toks.length * 8 + 64;

  /**
   * CommonMark's `openers_bottom`: when a closer of a given class finds no
   * opener, no later closer of that same class can match anything at or before
   * that point either (openers are only ever consumed, never added). Keyed by
   * delimiter class, valued by the scan-order `seq` below which not to search.
   * Without this, `*a**b*` repeated N times is O(N^2).
   */
  const openersBottom = new Map<string, number>();
  const classOf = (d: DelimTok): string => `${d.char}|${d.origCount % 3}|${d.canOpen ? 1 : 0}`;

  while (c < toks.length) {
    if (++guard > maxIter) break; // linearity backstop — leftovers literalize
    const closer = toks[c];
    if (closer === undefined || closer.kind !== 'delim' || !closer.canClose || closer.count === 0) {
      c++;
      continue;
    }

    const key = classOf(closer);
    const bottom = openersBottom.get(key) ?? -1;

    // Find nearest opener.
    let o = -1;
    for (let k = c - 1; k >= 0; k--) {
      const cand = toks[k];
      if (cand === undefined || cand.kind !== 'delim') continue;
      if (cand.seq <= bottom) break;
      if (cand.char !== closer.char || !cand.canOpen || cand.count === 0) continue;
      // Rule of three.
      if (
        (cand.canClose || closer.canOpen) &&
        (cand.origCount + closer.origCount) % 3 === 0 &&
        !(cand.origCount % 3 === 0 && closer.origCount % 3 === 0)
      ) {
        continue;
      }
      o = k;
      break;
    }

    if (o === -1) {
      openersBottom.set(key, closer.seq);
      c++;
      continue;
    }

    const opener = toks[o] as DelimTok;
    const strength = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const children = assemble(toks.slice(o + 1, c));
    const node: Inline =
      closer.char === '~'
        ? { type: 'delete', children }
        : strength === 2
          ? { type: 'strong', children }
          : { type: 'emphasis', children };

    opener.count -= strength;
    closer.count -= strength;

    if (c > o + 1) {
      // Overwrite the span in place instead of splicing it out.
      //
      // Every splice shifts the whole tail, so a paragraph with N bold spans —
      // ordinary, valid markdown — used to cost O(N^2). Writing the node into
      // the first inner slot and blanking the rest touches only the span, which
      // makes the whole pass linear. Exhausted delimiters are left where they
      // are: `assemble` skips a delimiter whose count reached zero, and so do
      // the searches above, so removing them would be pure cost.
      toks[o + 1] = { kind: 'node', node };
      for (let k = o + 2; k < c; k++) toks[k] = text('');
      // Indices are unchanged, so re-examine this closer: `***a***` needs a
      // second pass over the same pair to nest em inside strong. Each pass
      // drops at least two from the delimiter counts, so this terminates.
      continue;
    }

    // Degenerate span with nothing between the delimiters (`****`).
    toks.splice(o + 1, 0, { kind: 'node', node });
    c = o + 1;
  }
}

// ---------------------------------------------------------------------------
// Recovery passes
// ---------------------------------------------------------------------------


/**
 * `<b>x</b>` / `<em>x</em>` / `<del>x</del>` mean exactly what `**x**`, `*x*`
 * and `~~x~~` mean; fold them into the same nodes so consumers see one AST
 * shape. Unmatched halves fall back to raw htmlInline in `assemble`.
 */
export function foldHtmlSpans(toks: Tok[], ctx: Ctx, finalize: (t: Tok[], c: Ctx) => Inline[]): void {
  // Built into a fresh array with an opener stack rather than spliced in place.
  // Splicing costs O(n) per fold, which made a run of many `<b>x</b>` spans
  // quadratic. The stack also gives correct nesting for free.
  const out: Tok[] = [];
  // Each entry marks where an unmatched opener sits in `out`.
  const openers: Array<{ at: number; node: 'strong' | 'emphasis' | 'delete' }> = [];

  for (const tok of toks) {
    if (tok.kind !== 'htmlSpan' || tok.used) {
      out.push(tok);
      continue;
    }

    if (!tok.closing) {
      // Past the cap the marker stays literal text. Without this, input like
      // `<b>` repeated thousands of times builds an inline tree deeper than
      // any recursive consumer — including this library's own renderer — can
      // walk, turning a parse that "succeeded" into a stack overflow later.
      if (openers.length >= MAX_INLINE_NESTING) {
        out.push({ kind: 'node', node: { type: 'text', value: tok.raw } });
        continue;
      }
      openers.push({ at: out.length, node: tok.node });
      out.push(tok);
      continue;
    }

    // Closing tag: find the innermost matching opener still unclosed.
    let si = -1;
    for (let k = openers.length - 1; k >= 0; k--) {
      if (openers[k]!.node === tok.node) {
        si = k;
        break;
      }
    }
    if (si === -1) {
      out.push(tok);
      continue;
    }

    const at = openers[si]!.at;
    openers.length = si; // anything opened inside is closed implicitly
    const inner = out.splice(at, out.length - at).slice(1);
    const children = finalize(inner, ctx);
    out.push({ kind: 'node', node: { type: tok.node, children } as Inline });
  }

  toks.length = 0;
  for (const t of out) toks.push(t);
}

/**
 * Interleaved ranges — `**A *B** C*` — where two emphasis runs of different
 * species overlap instead of nesting. Split the inner run at the outer closer
 * (the same repair an HTML parser's adoption agency performs) so both spans
 * survive and no delimiter is left stranded as literal text.
 */
export function splitCrossingRanges(toks: Tok[], ctx: Ctx): boolean {
  // Index of the emphasis delimiters, in order. Line breaks reset the window:
  // a crossing pair only makes sense within one line.
  const run: number[] = [];
  const consider = (): boolean => {
    for (let a = 0; a + 3 < run.length; a++) {
      const i0 = run[a]!;
      const i1 = run[a + 1]!;
      const i2 = run[a + 2]!;
      const i3 = run[a + 3]!;
      const d0 = toks[i0] as DelimTok;
      const d1 = toks[i1] as DelimTok;
      const d2 = toks[i2] as DelimTok;
      const d3 = toks[i3] as DelimTok;
      // Two openers followed by two closers…
      if (!(d0.canOpen && !d0.canClose && d1.canOpen && !d1.canClose)) continue;
      if (!(d2.canClose && !d2.canOpen && d3.canClose && !d3.canOpen)) continue;
      // …whose natural partners cross: d0↔d2 and d1↔d3.
      if (d0.char !== d2.char || d0.count !== d2.count) continue;
      if (d1.char !== d3.char || d1.count !== d3.count) continue;
      // The two species must differ, otherwise `*a *b* c*` (proper nesting) is
      // indistinguishable from a crossing.
      if (d0.char === d1.char && d0.count === d1.count) continue;
      // Each range needs content.
      if (i1 - i0 < 2 || i2 - i1 < 2 || i3 - i2 < 2) continue;

      ctx.diag.repair(
        'emphasis-crossed-ranges',
        `Overlapping '${d0.char.repeat(d0.count)}' and '${d1.char.repeat(d1.count)}' ranges were split so both nest properly`,
        d0.line,
      );
      const closeD1: DelimTok = { ...d1, canOpen: false, canClose: true, seq: d1.seq + 0.25 };
      const openD1: DelimTok = { ...d1, canOpen: true, canClose: false, seq: d1.seq + 0.5 };
      // Insert the synthetic closer before d2 and the synthetic opener after it.
      toks.splice(i2 + 1, 0, openD1);
      toks.splice(i2, 0, closeD1);
      // The reopened range starts on the space that separated the two halves.
      // Emphasis bodies get their edges trimmed, so lift that space out or the
      // two spans would be rendered flush against each other.
      const head = toks[i2 + 3];
      if (head !== undefined && head.kind === 'node' && head.node.type === 'text') {
        const lead = /^\s+/.exec(head.node.value);
        if (lead !== null && head.node.value.length > lead[0].length) {
          head.node.value = head.node.value.slice(lead[0].length);
          toks.splice(i2 + 2, 0, text(lead[0]));
        }
      }
      return true; // indices are stale; one split per block is plenty
    }
    return false;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'delim' && t.char !== '~' && t.count > 0) run.push(i);
    else if (isBreakTok(t)) {
      if (run.length >= 4 && consider()) return true;
      run.length = 0;
    }
  }
  return run.length >= 4 ? consider() : false;
}

/**
 * A delimiter run that was only partly consumed (`***breaking**` leaves one
 * `*`) is punctuation debris, not an opener. Dropping it stops the leftover
 * from emphasizing the rest of the sentence and from printing as a literal.
 */
export function dropOrphanDelimiters(toks: Tok[], ctx: Ctx): void {
  for (const t of toks) {
    if (t.kind !== 'delim' || t.count === 0 || t.count === t.origCount) continue;
    ctx.diag.repair(
      'emphasis-orphan-delimiter',
      `Dropped ${t.count} leftover '${t.char}' from a mismatched '${t.char.repeat(t.origCount)}' run`,
      t.line,
    );
    t.count = 0;
  }
}

/**
 * `** bold **` — flanking failed only because of interior padding spaces.
 *
 * Restricted to `**`/`__` on purpose: a single space-surrounded `*` is
 * overwhelmingly arithmetic ("a * b * c") or a glob, never intended emphasis.
 */
export function recoverSpacePadded(toks: Tok[], ctx: Ctx): void {
  let budget = toks.length * 4 + 64; // linearity backstop

  // Rebuilt into a fresh array rather than spliced in place: each splice on a
  // large token list costs O(n), and a line of many padded pairs would then be
  // quadratic overall. Spans do not overlap, so one pass is enough.
  const out: Tok[] = [];
  let i = 0;

  const isOpener = (d: Tok | undefined): d is DelimTok =>
    d !== undefined &&
    d.kind === 'delim' &&
    d.char !== '~' &&
    d.count >= 2 &&
    (d.spaceAfter || d.canOpen) &&
    !(NUMERIC_OPERAND.test(d.prevWord) && NUMERIC_OPERAND.test(d.nextWord));

  while (i < toks.length) {
    const d1 = toks[i];
    if (!isOpener(d1)) {
      out.push(toks[i]!);
      i++;
      continue;
    }

    // Find a matching padded closer before any line break.
    let j = -1;
    for (let k = i + 1; k < toks.length; k++) {
      if (--budget < 0) break;
      const d2 = toks[k];
      if (d2 === undefined) break;
      if (isBreakTok(d2)) break;
      if (d2.kind !== 'delim' || d2.char !== d1.char || d2.count !== d1.count) continue;
      if (!d2.spaceBefore && !d2.canClose) continue;
      // At least one side must have failed on padding alone — a pair that both
      // flank correctly was already handled (or rejected) by processEmphasis.
      if (!d1.spaceAfter && !d2.spaceBefore) continue;
      if (NUMERIC_OPERAND.test(d2.prevWord) && NUMERIC_OPERAND.test(d2.nextWord)) break;
      if (k === i + 1) break; // no content between
      // `2 ** 3 ** 4` is exponentiation, not bold: skip when the delimiters sit
      // between digits and the span is a bare arithmetic expression.
      if (d1.prevIsDigit && d2.nextIsWord) {
        const between = toks.slice(i + 1, k);
        const flat = between.every((t) => t.kind === 'node' && t.node.type === 'text')
          ? between.map((t) => ((t as NodeTok).node as { value: string }).value).join('')
          : null;
        if (flat !== null && /^[\d\s+\-*/^().,]+$/.test(flat)) break;
      }
      j = k;
      break;
    }

    if (j === -1) {
      out.push(toks[i]!);
      i++;
      continue;
    }

    const inner = toks.slice(i + 1, j);
    trimEdgeSpaces(inner);
    const children = assemble(inner);
    if (children.length === 0) {
      out.push(toks[i]!);
      i++;
      continue;
    }

    const node: Inline = d1.count >= 2 ? { type: 'strong', children } : { type: 'emphasis', children };
    ctx.diag.repair('emphasis-space-padded', 'Space-padded emphasis delimiters matched; padding moved outside', d1.line);

    // Re-emit the padding outside the node, but only where the neighbouring
    // text doesn't already supply whitespace (avoids doubled spaces).
    const before = out[out.length - 1];
    const after = toks[j + 1];
    const needLead =
      before !== undefined && before.kind === 'node' && before.node.type === 'text' && !/\s$/.test(before.node.value);
    const needTrail = !(after !== undefined && after.kind === 'node' && after.node.type === 'text' && /^\s/.test(after.node.value));
    if (needLead) out.push(text(' '));
    out.push({ kind: 'node', node });
    if (needTrail) out.push(text(' '));
    i = j + 1;
  }

  toks.length = 0;
  for (const t of out) toks.push(t);
}


/** `__bold**` — opener and closer of different species but same strength. */
export function recoverSpeciesMismatch(toks: Tok[], ctx: Ctx): void {
  let budget = toks.length * 4 + 64; // linearity backstop
  for (let i = 0; i < toks.length; i++) {
    const d1 = toks[i];
    if (d1 === undefined || d1.kind !== 'delim' || d1.char === '~' || !d1.canOpen || d1.count === 0) continue;
    const other = d1.char === '*' ? '_' : '*';
    for (let j = i + 1; j < toks.length; j++) {
      if (--budget < 0) return;
      const d2 = toks[j];
      if (d2 === undefined) break;
      if (isBreakTok(d2)) break;
      if (d2.kind !== 'delim') continue;
      if (d2.char === d1.char && (d2.canClose || d2.canOpen)) break; // same-species candidate exists; leave to std algorithm results
      if (d2.char !== other || !d2.canClose) continue;
      const sameStrength = (d1.count >= 2) === (d2.count >= 2);
      if (!sameStrength) continue;
      if (j === i + 1) break;
      const inner = toks.splice(i + 1, j - i - 1);
      const children = assemble(inner);
      if (children.length === 0) break;
      const node: Inline = d1.count >= 2 ? { type: 'strong', children } : { type: 'emphasis', children };
      ctx.diag.repair('emphasis-auto-closed', `Matched '${d1.char.repeat(d1.count)}' with '${d2.char.repeat(d2.count)}' (mixed delimiter styles)`, d1.line);
      toks.splice(i, 2, { kind: 'node', node });
      break;
    }
  }
}

/**
 * `~~struck~` — a `~~` opener answered by a single `~`. A lone `~` is never
 * tokenized as a delimiter (`~/.config` and `~200ms` are far more common than
 * single-tilde strikethrough), so the closer has to be dug out of a text node.
 * Requiring a real `~~` opener first is what keeps home-directory paths safe.
 */
export function recoverTildeMismatch(toks: Tok[], ctx: Ctx): void {
  let skipUntil = -1;
  for (let i = 0; i < toks.length; i++) {
    const d = toks[i];
    if (d === undefined || d.kind !== 'delim' || d.char !== '~' || !d.canOpen || d.count === 0) continue;
    if (i < skipUntil) continue;
    let j = i + 1;
    let found = -1;
    let at = -1;
    for (; j < toks.length; j++) {
      const t = toks[j]!;
      if (isBreakTok(t)) break;
      if (t.kind !== 'node' || t.node.type !== 'text') continue;
      const value = t.node.value;
      const k = value.indexOf('~');
      if (k === -1) continue;
      // The closer must be right-flanking: preceded by content, followed by
      // whitespace or punctuation.
      const prevCh = k > 0 ? value[k - 1] : undefined;
      const nextCh = value[k + 1];
      if (k === 0 || isWs(prevCh)) continue;
      if (nextCh !== undefined && !isWs(nextCh) && !isPunct(nextCh)) continue;
      found = j;
      at = k;
      break;
    }
    if (found === -1) {
      skipUntil = j; // nothing closes on this line; later openers fail too
      continue;
    }
    const closerTok = toks[found] as NodeTok;
    const value = (closerTok.node as { value: string }).value;
    const contentToks: Tok[] = toks.slice(i + 1, found);
    const head = value.slice(0, at);
    if (head !== '') contentToks.push(text(head));
    const children = assemble(contentToks);
    if (children.length === 0) continue;
    const tail = value.slice(at + 1);
    const replacement: Tok[] = [{ kind: 'node', node: { type: 'delete', children } }];
    if (tail !== '') replacement.push(text(tail));
    ctx.diag.repair('strikethrough-single-tilde', "Strikethrough opened with '~~' and closed with a single '~'", d.line);
    toks.splice(i, found - i + 1, ...replacement);
  }
}

/**
 * `*  text  *` where the block parser already claimed the leading `*` as a list
 * bullet: the survivor can neither open nor close anything and would print as a
 * stray asterisk. Only the very last token of the block qualifies, so
 * "a * b * c" keeps every one of its asterisks.
 */
export function dropTrailingDeadDelimiter(toks: Tok[], ctx: Ctx): void {
  const last = toks[toks.length - 1];
  if (last === undefined || last.kind !== 'delim') return;
  if (last.char === '~' || last.count === 0) return;
  if (last.canOpen || last.canClose) return;
  if (!last.spaceBefore || !last.spaceAfter) return;
  if (toks.length < 2) return;
  // Only when it is the block's sole surviving delimiter: in delimiter-rich
  // text a literal asterisk is far more likely to be deliberate.
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i]!;
    if (t.kind === 'delim' && t.count > 0) return;
  }
  ctx.diag.repair(
    'emphasis-orphan-delimiter',
    `Dropped a trailing '${last.char.repeat(last.count)}' that had nothing left to pair with`,
    last.line,
  );
  last.count = 0;
}

/**
 * `**bold that never closes` — auto-close at end of line. For the very common
 * `**Label: rest of text` list-item pattern, close right after the colon.
 */
export function recoverUnclosed(toks: Tok[], ctx: Ctx): void {
  for (let i = 0; i < toks.length; i++) {
    const d = toks[i];
    if (d === undefined || d.kind !== 'delim' || d.char === '~' || !d.canOpen || d.count === 0) continue;
    // Real emphasis opens on a word. `*.py`, `*/glob`, `**/*.ts` and similar
    // path/glob fragments must stay literal.
    if (!d.nextIsWord) continue;

    // Extent: to the next line break or end of tokens.
    let extent = toks.length;
    for (let j = i + 1; j < toks.length; j++) {
      if (isBreakTok(toks[j]!)) {
        extent = j;
        break;
      }
    }
    if (extent === i + 1) continue; // nothing to wrap

    // Label heuristic: opener starts the block/line and a colon appears early.
    let closeAt = extent;
    let usedLabel = false;
    const atLineStart = i === 0 || isBreakTok(toks[i - 1]!);
    if (atLineStart && d.count >= 2) {
      const first = toks[i + 1];
      if (first !== undefined && first.kind === 'node' && first.node.type === 'text') {
        const colonIdx = first.node.value.indexOf(':');
        if (colonIdx > 0 && colonIdx <= 60 && first.node.value.slice(0, colonIdx).split(/\s+/).length <= 8) {
          // Split the text node at the colon.
          const before = first.node.value.slice(0, colonIdx + 1);
          const after = first.node.value.slice(colonIdx + 1);
          first.node.value = before;
          if (after !== '') toks.splice(i + 2, 0, text(after));
          closeAt = i + 2;
          usedLabel = true;
        }
      }
    }

    const inner = toks.splice(i + 1, closeAt - i - 1);
    trimEdgeSpaces(inner);
    const children = assemble(inner);
    if (children.length === 0) {
      toks.splice(i + 1, 0, ...inner);
      continue;
    }
    const node: Inline = d.count >= 2 ? { type: 'strong', children } : { type: 'emphasis', children };
    ctx.diag.repair(
      'emphasis-auto-closed',
      usedLabel
        ? `Unclosed '${d.char.repeat(d.origCount)}' closed after the label colon`
        : `Unclosed '${d.char.repeat(d.origCount)}' auto-closed at end of line`,
      d.line,
    );
    toks.splice(i, 1, { kind: 'node', node });
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------
