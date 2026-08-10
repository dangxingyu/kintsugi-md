/**
 * Kintsugi — AST, diagnostics, and options.
 *
 * Design contract: parsing NEVER throws. Every deviation from strict
 * CommonMark/GFM that we repair is recorded as a Diagnostic, so callers can
 * audit exactly what the parser did to make sense of the input.
 */

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** 1-based line range in the ORIGINAL source (before any unwrapping). */
export interface Pos {
  /** 1-based first line of the node. */
  startLine: number;
  /** 1-based last line of the node (inclusive). */
  endLine: number;
}

// ---------------------------------------------------------------------------
// Inline nodes
// ---------------------------------------------------------------------------

export interface Text {
  type: 'text';
  value: string;
}

export interface Strong {
  type: 'strong';
  children: Inline[];
}

export interface Emphasis {
  type: 'emphasis';
  children: Inline[];
}

export interface Delete {
  type: 'delete';
  children: Inline[];
}

/** `==highlighted==` — not CommonMark, but common in LLM output. */
export interface Mark {
  type: 'mark';
  children: Inline[];
}

/** A `[^1]` reference pointing at its definition. */
export interface FootnoteRef {
  type: 'footnoteRef';
  label: string;
  /** 1-based order of first appearance, used for the visible marker. */
  index: number;
}

export interface InlineCode {
  type: 'inlineCode';
  value: string;
}

export interface Link {
  type: 'link';
  url: string;
  title: string | null;
  children: Inline[];
}

export interface Image {
  type: 'image';
  url: string;
  title: string | null;
  alt: string;
}

export interface InlineMath {
  type: 'inlineMath';
  /** Raw TeX content, delimiters stripped. */
  value: string;
}

export interface HtmlInline {
  type: 'htmlInline';
  value: string;
}

export interface HardBreak {
  type: 'hardBreak';
}

export interface SoftBreak {
  type: 'softBreak';
}

export type Inline =
  | Text
  | Strong
  | Emphasis
  | Delete
  | Mark
  | FootnoteRef
  | InlineCode
  | Link
  | Image
  | InlineMath
  | HtmlInline
  | HardBreak
  | SoftBreak;

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

export interface Document {
  type: 'document';
  children: Block[];
  pos: Pos;
}

export interface Frontmatter {
  type: 'frontmatter';
  /** Raw text between the --- fences (not YAML-parsed). */
  value: string;
  pos: Pos;
}

export interface Heading {
  type: 'heading';
  /** 1..6 (deeper inputs are clamped, with a diagnostic). */
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  children: Inline[];
  /** True when produced by a setext underline (=== / ---). */
  setext: boolean;
  pos: Pos;
}

export interface Paragraph {
  type: 'paragraph';
  children: Inline[];
  pos: Pos;
}

export interface CodeBlock {
  type: 'codeBlock';
  /** Full info string after the fence, trimmed ('' for none / indented code). */
  info: string;
  /** First word of info, lowercased — the language tag. */
  lang: string;
  value: string;
  fenced: boolean;
  /** True when the fence was never closed and we auto-closed at EOF/boundary. */
  autoClosed: boolean;
  pos: Pos;
}

export interface Blockquote {
  type: 'blockquote';
  children: Block[];
  /**
   * GitHub alert kind when the quote opened with `> [!NOTE]` and friends,
   * lowercased ('note' | 'tip' | 'important' | 'warning' | 'caution').
   */
  alert: string | null;
  pos: Pos;
}

/**
 * Model scaffolding that leaked into the output — `<thinking>` blocks, chat
 * control tokens like `<|im_end|>`, stray `</output>` closers.
 *
 * Kept in the AST (nothing is ever discarded) but omitted from rendered HTML
 * unless `showScaffolding` is set, because it is not part of the document the
 * author meant to produce.
 */
export interface Scaffolding {
  type: 'scaffolding';
  /** The tag or token that identified it, lowercased. */
  kind: string;
  value: string;
  pos: Pos;
}

/** A `:::note … :::` fenced container (Docusaurus / MkDocs admonition). */
export interface Container {
  type: 'container';
  /** The word after the colons, lowercased ('note', 'warning', …). */
  kind: string;
  /** Optional title on the opening line. */
  title: string | null;
  children: Block[];
  pos: Pos;
}

export interface DefinitionItem {
  term: Inline[];
  definitions: Inline[][];
}

/** A Pandoc-style definition list (`Term` / `: definition`). */
export interface DefinitionList {
  type: 'definitionList';
  items: DefinitionItem[];
  pos: Pos;
}

export interface FootnoteDefinition {
  label: string;
  index: number;
  children: Inline[];
}

/** The collected `[^1]: …` definitions, emitted once at the end of the document. */
export interface FootnoteList {
  type: 'footnoteList';
  items: FootnoteDefinition[];
  pos: Pos;
}

export interface List {
  type: 'list';
  ordered: boolean;
  /** Start number for ordered lists. */
  start: number;
  /** Tight lists render children without <p> wrappers. */
  tight: boolean;
  children: ListItem[];
  pos: Pos;
}

export interface ListItem {
  type: 'listItem';
  /** null = not a task item; true/false = checked state. */
  checked: boolean | null;
  children: Block[];
  pos: Pos;
}

export type Align = 'left' | 'center' | 'right' | null;

export interface Table {
  type: 'table';
  align: Align[];
  /** First row is the header unless headerless is true. */
  rows: TableRow[];
  /** True when no separator row existed and none could be inferred as header. */
  headerless: boolean;
  /** True when the separator row was missing and we inferred the header. */
  inferredSeparator?: boolean;
  pos: Pos;
}

export interface TableRow {
  type: 'tableRow';
  cells: TableCell[];
}

export interface TableCell {
  type: 'tableCell';
  children: Inline[];
}

export interface ThematicBreak {
  type: 'thematicBreak';
  pos: Pos;
}

export interface HtmlBlock {
  type: 'htmlBlock';
  value: string;
  pos: Pos;
}

export interface MathBlock {
  type: 'mathBlock';
  /** Raw TeX content, delimiters stripped. */
  value: string;
  pos: Pos;
}

export type Block =
  | Frontmatter
  | Heading
  | Paragraph
  | CodeBlock
  | Blockquote
  | Container
  | DefinitionList
  | Scaffolding
  | FootnoteList
  | List
  | ListItem
  | Table
  | ThematicBreak
  | HtmlBlock
  | MathBlock;

export type Node = Document | Block | TableRow | TableCell | Inline;

// ---------------------------------------------------------------------------
// Diagnostics — the repair log
// ---------------------------------------------------------------------------

/**
 * Every tolerance the parser applies is logged with one of these codes.
 * 'repair' = we changed the strict interpretation to honor evident intent.
 * 'note'   = we observed something odd but the interpretation was unambiguous.
 */
export type DiagnosticCode =
  // document level
  | 'doc-unwrapped-fence'
  | 'doc-normalized-line-endings'
  | 'doc-stripped-bom'
  | 'doc-invisible-chars'
  // code fences
  | 'fence-unclosed'
  | 'fence-mismatched-char'
  | 'fence-mismatched-length'
  | 'fence-nested-markdown'
  | 'fence-close-trailing-text'
  // headings
  | 'heading-missing-space'
  | 'heading-depth-clamped'
  | 'setext-vs-break-ambiguity'
  // frontmatter
  | 'frontmatter-unclosed'
  // tables
  | 'table-missing-separator'
  | 'table-ragged-row'
  | 'table-separator-mismatch'
  | 'table-nonstandard-separator'
  | 'table-merged-continuation'
  | 'table-interrupts-paragraph'
  // lists
  | 'list-unicode-bullet'
  | 'list-paren-number'
  | 'list-indent-adjusted'
  | 'list-nonsequential-numbers'
  | 'task-marker-nonstandard'
  // inline
  | 'emphasis-auto-closed'
  | 'emphasis-space-padded'
  | 'emphasis-crossed-ranges'
  | 'emphasis-orphan-delimiter'
  | 'code-span-auto-closed'
  | 'code-span-nested-backtick'
  | 'code-span-smart-quotes'
  | 'link-space-before-paren'
  | 'link-unclosed'
  | 'link-url-spaces'
  | 'link-missing-bracket'
  | 'link-missing-parens'
  | 'link-transposed'
  | 'link-ref-undefined'
  | 'image-space-before-bracket'
  | 'image-transposed-bang'
  | 'strikethrough-single-tilde'
  | 'math-auto-closed'
  // extensions LLMs emit that CommonMark lacks
  | 'container-unclosed'
  | 'extension-syntax'
  | 'scaffolding-removed'
  // misc
  | 'html-escaped-unknown-tag'
  | 'hr-nonstandard-chars'
  | 'indented-prose-not-code'
  | 'nesting-depth-capped';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'repair' | 'note';
  message: string;
  /** 1-based line in the original source. */
  line: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /**
   * If the entire document is wrapped in a single ```markdown fence (a very
   * common LLM chat artifact), unwrap it and parse the content. Default true.
   */
  unwrapDocumentFence?: boolean;
  /** Recognize $...$, $$...$$, \(...\), \[...\] as math nodes. Default true. */
  math?: boolean;
  /** Recognize --- frontmatter at document start. Default true. */
  frontmatter?: boolean;
  /**
   * Recovery aggressiveness for inline delimiters (auto-closing unclosed
   * **bold, `code, etc). 'auto' repairs with diagnostics; 'strict' falls back
   * to CommonMark literalization. Default 'auto'.
   */
  inlineRecovery?: 'auto' | 'strict';
  /**
   * How a lone bold line is judged to be a section heading. 'auto' uses the
   * hand-written rule where its ASCII title-case signal applies, and a small
   * pinned classifier elsewhere — which is what makes headings work in Chinese,
   * Japanese, Korean and Arabic. 'rule' disables the classifier entirely.
   * Default 'auto'.
   */
  headingDetection?: 'rule' | 'auto';
}

export interface ParseResult {
  ast: Document;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  /** Lines offset applied when reporting (used after document unwrapping). */
  lineOffset = 0;

  add(code: DiagnosticCode, severity: Diagnostic['severity'], message: string, line: number): void {
    this.items.push({ code, severity, message, line: line + this.lineOffset });
  }

  repair(code: DiagnosticCode, message: string, line: number): void {
    this.add(code, 'repair', message, line);
  }

  note(code: DiagnosticCode, message: string, line: number): void {
    this.add(code, 'note', message, line);
  }
}
