import type { Block, Document, ParseOptions, ParseResult } from './types.js';
import { DiagnosticBag } from './types.js';
import { toLines, isBlank } from './preprocess.js';
import type { Line } from './preprocess.js';
import { parseBlocks } from './block-parser.js';
import { collectRefs, detectAtxStyle, detectRichDocument } from './context.js';
import { parseInlines } from './inline-parser.js';
import type { Ctx } from './context.js';
import { renderHtml } from './renderer.js';
import type { RenderOptions } from './renderer.js';

const DEFAULTS: Required<ParseOptions> = {
  unwrapDocumentFence: true,
  math: true,
  frontmatter: true,
  inlineRecovery: 'auto',
};

/**
 * Parse markdown. Never throws: any input yields a Document plus the list of
 * repairs that were applied to get there.
 */
export function parse(src: string, options: ParseOptions = {}): ParseResult {
  const opts: Required<ParseOptions> = { ...DEFAULTS, ...options };
  const diag = new DiagnosticBag();

  try {
    let lines = toLines(src ?? '', diag);

    if (opts.unwrapDocumentFence) {
      lines = maybeUnwrapDocumentFence(lines, diag);
    }

    const ctx: Ctx = {
      diag,
      options: opts,
      refs: new Map(),
      refLines: new Set(),
      prefersThematicBreak: detectAtxStyle(lines),
      richDocument: detectRichDocument(lines),
      depth: 0,
      footnoteOrder: [],
      footnoteDefs: new Map(),
      footnoteIndex: new Map(),
    };
    ctx.refLines = collectRefs(lines, ctx);

    const children: Block[] = parseBlocks(lines, ctx, true);

    // Footnote definitions are gathered up front but rendered at the end, in
    // order of first reference — the same place a reader expects them.
    // Definitions the document never referenced still belong to the document —
    // dropping them would delete content — so they are appended after the ones
    // that were referenced, in source order.
    for (const label of ctx.footnoteDefs.keys()) {
      if (!ctx.footnoteIndex.has(label)) {
        ctx.footnoteOrder.push(label);
        ctx.footnoteIndex.set(label, ctx.footnoteOrder.length);
        diag.note('extension-syntax', `Footnote [^${label}] is defined but never referenced; kept it`, 1);
      }
    }
    if (ctx.footnoteOrder.length > 0) {
      const items = ctx.footnoteOrder.map((label: string, i: number) => {
        const body = ctx.footnoteDefs.get(label);
        if (body === undefined) {
          diag.repair('extension-syntax', `Footnote reference [^${label}] has no definition`, 1);
        }
        return { label, index: i + 1, children: parseInlines(body ?? `[^${label}]`, 1, ctx) };
      });
      const lastLine = lines[lines.length - 1]?.lineNo ?? 1;
      children.push({ type: 'footnoteList', items, pos: { startLine: lastLine, endLine: lastLine } });
    }

    const ast: Document = {
      type: 'document',
      children,
      pos: {
        startLine: lines[0]?.lineNo ?? 1,
        endLine: lines[lines.length - 1]?.lineNo ?? 1,
      },
    };
    return { ast, diagnostics: diag.items };
  } catch (err) {
    // Contract: parsing never throws. If a heuristic ever does, fall back to
    // the whole input as preformatted text rather than failing the caller.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ast: {
        type: 'document',
        children: [
          {
            type: 'codeBlock',
            info: '',
            lang: '',
            value: src ?? '',
            fenced: false,
            autoClosed: false,
            pos: { startLine: 1, endLine: 1 },
          },
        ],
        pos: { startLine: 1, endLine: 1 },
      },
      diagnostics: [
        ...diag.items,
        {
          code: 'doc-unwrapped-fence',
          severity: 'repair',
          message: `Internal parser error (${message}); fell back to plain text`,
          line: 1,
        },
      ],
    };
  }
}

/** Parse and render to HTML in one call. */
export function render(src: string, options: ParseOptions & RenderOptions = {}): { html: string; diagnostics: ParseResult['diagnostics'] } {
  const { ast, diagnostics } = parse(src, options);
  return { html: renderHtml(ast, options), diagnostics };
}

/**
 * LLM chat answers are often delivered as one big ```markdown fence. If the
 * whole document is a single fence whose language is markdown-ish (or absent
 * but whose content is clearly markdown), unwrap it.
 */
function maybeUnwrapDocumentFence(lines: Line[], diag: DiagnosticBag): Line[] {
  let first = 0;
  let end = lines.length - 1;
  while (first < lines.length && isBlank(lines[first]!.text)) first++;
  while (end > first && isBlank(lines[end]!.text)) end--;
  if (end - first < 2) return lines;

  // The fence must be the last thing in the document. A markdown tutorial
  // explains its example afterwards; a chat wrapper does not.
  //
  // A wrapper the model never closed counts too: generation cut off mid-answer
  // is the single most common way these arrive, and leaving it fenced turns the
  // whole report into one code block.
  const closeM = /^(`{3,}|~{3,})[ \t]*$/.exec(lines[end]!.text.trim());
  let truncated = false;
  let closeMarker: string;
  if (closeM) {
    closeMarker = closeM[1]!;
  } else {
    // Exactly one fence line in the whole document — the opener that was never
    // closed. More than one means the fences pair up somewhere and this is an
    // interior example, not a wrapper around the answer.
    const fenceLines = lines.slice(first, end + 1).filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l.text));
    if (fenceLines.length !== 1) return lines;
    const openM = /^(`{3,}|~{3,})[ \t]*(\w*)[ \t]*$/.exec(fenceLines[0]!.text.trim());
    const lang0 = (openM?.[2] ?? '').toLowerCase();
    // Only for an explicitly markdown-tagged wrapper: an unclosed ```python is
    // simply a truncated code block and must stay one.
    if (!openM || !['markdown', 'md', 'mdx', 'gfm', 'commonmark'].includes(lang0)) return lines;
    closeMarker = openM[1]!;
    truncated = true;
    end = end + 1; // nothing to exclude; the body runs to the end of input
  }
  const fenceChar = closeMarker[0]!;

  // Find the opener: the first fence line of the same species. Anything before
  // it is a chat lead-in ("Here's the report:") that we keep as prose.
  let start = -1;
  let lang = '';
  for (let i = first; i < end; i++) {
    const m = new RegExp(`^\\${fenceChar}{3,}[ \\t]*(\\w*)[ \\t]*$`).exec(lines[i]!.text.trim());
    if (m) {
      start = i;
      lang = (m[1] ?? '').toLowerCase();
      break;
    }
  }
  if (start === -1) return lines;

  const lead = lines.slice(first, start);
  // A long or structured preamble means this fence is an example inside a
  // real document, not a wrapper around one.
  if (lead.length > 4) return lines;
  if (lead.some((l) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l.text))) return lines;

  const inner = lines.slice(start + 1, end);
  if (inner.length < 3) return lines;

  const markdownish =
    lang === 'markdown' || lang === 'md' || lang === 'mdx' || lang === 'gfm' || lang === 'commonmark';
  if (!markdownish && lang !== '') return lines; // ```json etc. — a real code block

  // Content must be unmistakably markdown: several structural signals.
  const signals = inner.filter((l) =>
    /^#{1,6}\s+\S/.test(l.text) || /^\s*[-*+]\s+\S/.test(l.text) || /^\s*\d+[.)]\s+\S/.test(l.text) || /^\s*\|.*\|/.test(l.text),
  ).length;
  const hasHeading = inner.some((l) => /^#{1,6}\s+\S/.test(l.text));

  // Complete inner fences are the classic reason to nest a ```markdown block:
  // the author is showing markdown source. Leave those alone. Broken (odd)
  // inner fencing means the model lost track, so unwrapping is still right.
  const innerFences = inner.filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l.text)).length;
  if (innerFences >= 2 && innerFences % 2 === 0) return lines;

  if (markdownish) {
    // An explicit ```markdown tag says "this is markdown". Unwrap it when it
    // holds a document (which has headings); a fence that merely demonstrates
    // syntax — a bare table or list — is an example and stays code.
    if (!hasHeading) return lines;
  } else {
    // Untagged fence: only unwrap on strong, dense evidence, since the model
    // may simply have fenced something it did not label.
    if (signals < 2 || signals < inner.length * 0.2) return lines;
  }

  diag.repair(
    'doc-unwrapped-fence',
    lead.length > 0
      ? `Document body was wrapped in a ${lang !== '' ? '`' + lang + '` ' : ''}code fence after a lead-in line; unwrapped it`
      : `Whole document was wrapped in a ${lang !== '' ? '`' + lang + '` ' : ''}code fence${truncated ? ' that generation never closed' : ''}; unwrapped it`,
    lines[start]!.lineNo,
  );
  return [...lead, ...inner];
}

export { renderHtml } from './renderer.js';
export type { RenderOptions } from './renderer.js';
export type {
  Align,
  Block,
  Blockquote,
  CodeBlock,
  Delete,
  Diagnostic,
  DiagnosticCode,
  Document,
  Emphasis,
  Frontmatter,
  HardBreak,
  Heading,
  HtmlBlock,
  HtmlInline,
  Image,
  Inline,
  InlineCode,
  InlineMath,
  Link,
  List,
  ListItem,
  MathBlock,
  Node,
  Paragraph,
  ParseOptions,
  ParseResult,
  Pos,
  SoftBreak,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
  ThematicBreak,
} from './types.js';
