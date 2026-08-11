<h1 align="center">Kintsugi</h1>

<p align="center">
  <strong>A markdown parser that never fails on LLM output.</strong><br>
  It repairs what the model broke — and shows you every seam.
</p>

<p align="center">
  <a href="https://dangxingyu.github.io/kintsugi-md/">Live demo</a> ·
  <a href="#what-it-repairs">What it repairs</a> ·
  <a href="#what-it-deliberately-does-not-repair">What it won't</a> ·
  <a href="#api">API</a>
</p>

---

*Kintsugi* (金継ぎ) is the Japanese craft of mending broken pottery with gold, so the repair becomes
part of the object rather than something hidden. That is exactly this parser's contract: it will
not refuse a broken document, and it will not quietly paper over the break either. Every repair is
recorded as a diagnostic with a source line, so you always know what was mended and where.

## Why

Mainstream markdown parsers (VS Code's preview, Notion's importer, Typora, anything built on strict
CommonMark) are written for markdown that a careful human wrote. LLM-generated markdown is
different: it gets truncated mid-fence, it forgets the `|---|` separator row, it opens `**bold` and
never closes it, it writes `##Heading` without the space, it wraps a whole answer in a stray
```` ```markdown ```` fence, and it emits LaTeX like `\[ ... \]` that strict parsers happily eat
alive. Strict parsers respond by rendering the mistake literally — a table becomes a wall of pipes,
a report becomes one long code block — which is exactly the wrong outcome when you have a directory
full of generated reports to read.

Kintsugi takes the opposite stance. **Parsing never throws and never gives up.** Every input
produces a best-effort AST that honors what the author evidently meant, and every deviation from
strict CommonMark is recorded, so nothing is repaired behind your back.

```ts
import { render } from 'kintsugi-md';

const { html, diagnostics } = render(`
| Model | MMLU | GSM8K |
| GPT-4o | 88.7 | 94.2 |
| Claude 3.5 Sonnet | 88.3 | 96.4 |
`);
```

```html
<table>
<thead><tr><th>Model</th><th>MMLU</th><th>GSM8K</th></tr></thead>
<tbody>
<tr><td>GPT-4o</td><td>88.7</td><td>94.2</td></tr>
<tr><td>Claude 3.5 Sonnet</td><td>88.3</td><td>96.4</td></tr>
</tbody>
</table>
```

```
[repair] L2 table-missing-separator: Table had no separator row; treated the first row as the header
```

A strict GFM parser renders that same input as a single paragraph of literal pipe characters.

## Install

```bash
npm install kintsugi-md
```

## API

```ts
import { parse, render, renderHtml } from 'kintsugi-md';

const { ast, diagnostics } = parse(source, options);   // AST + repair log
const html = renderHtml(ast, renderOptions);           // AST -> HTML
const { html, diagnostics } = render(source, options); // both in one call
```

### `ParseOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `unwrapDocumentFence` | `true` | Unwrap a whole document that was wrapped in one ```` ```markdown ```` fence |
| `math` | `true` | Recognize `$…$`, `$$…$$`, `\(…\)`, `\[…\]` as math nodes |
| `frontmatter` | `true` | Recognize `---` YAML frontmatter at the top of the document |
| `inlineRecovery` | `'auto'` | `'auto'` repairs unclosed inline delimiters; `'strict'` literalizes them CommonMark-style |
| `headingDetection` | `'auto'` | How a bold line is judged to be a heading: `'auto'` uses the multilingual classifier where the rule is blind; `'rule'` disables it |
| `promoteBoldHeadings` | `false` | Whether a lone bold line (`**Overview**`) may become a heading at all. Off by default — see note below |

### `RenderOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `math` | `'delimiters'` | Re-emit math with `$` delimiters inside a `.math` span/div, ready for KaTeX/MathJax |
| `allowHtml` | `true` | Emit raw HTML blocks as-is; when `false` they are escaped |
| `showFrontmatter` | `false` | Render frontmatter as a `<pre>` block instead of dropping it |
| `showScaffolding` | `false` | Render leaked `<thinking>` blocks and chat control tokens (always present in the AST regardless) |

> **On `promoteBoldHeadings`:** a lone bold line like `**Overview**` is as often
> deliberate emphasis (`**Warning: read this**`) as a heading a model forgot to
> mark with `#`. An audit of 3,090 real documents found default-on promotion
> invented roughly 4,000 headings with no clear wins, so it is off by default.
> Turn it on if your input is known to use bold as a heading substitute; the
> multilingual classifier then decides, so it works in Chinese, Japanese and
> Korean as well as English.

### Diagnostics

Every diagnostic has a `code`, a `severity` (`'repair'` when the strict reading was overridden,
`'note'` when the input was merely unusual), a `message`, and a 1-based `line` in the original
source. They are the audit trail: if a document renders in a way that surprises you, the
diagnostic log tells you which heuristic did it and where.

```ts
const { diagnostics } = parse(src);
for (const d of diagnostics) {
  console.log(`${d.severity} at line ${d.line}: ${d.code} — ${d.message}`);
}
```

## What it repairs

**Tables** — missing separator rows, separators whose cell count disagrees with the header, rows
with too many or too few cells (overflow is merged into the last cell rather than silently
truncated, which is what GFM does), missing outer pipes, em-dash and `===` separators, tables
split across a blank line, single-cell caption rows above a real table, and pipes inside code
spans staying in their cell. A row's delimiter is whichever pipe character it actually uses:
`｜` and `│` delimit a table that has no ASCII pipes, and stay ordinary punctuation inside one
that does, so `清醒FM｜Gen Z` and `[Challenge](a) │ [Solution](b)` keep their single cell.

**Code fences** — fences never closed before end of input, closers using the wrong character or a
shorter run than the opener, and nested fences inside a ```` ```markdown ```` block, where the
inner ```` ``` ```` is example content rather than the real closer.

**Inline emphasis** — `**bold` that is never closed (closed at end of line, or right after the
label colon for the very common `**Label: text` bullet pattern), `** padded bold **` that strict
flanking rules refuse, and mismatched delimiter species like `__bold**`.

**Math** — `$x$`, `$$…$$`, `\(x\)`, `\[…\]` and bare `\begin{align}` environments all survive as
math nodes instead of being dismembered into emphasis and brackets. `$5 and $10` is still money.

Kintsugi recognises math and preserves the TeX; it does not typeset it. `renderHtml` emits
`<span class="math math-inline">$x$</span>` (or a `div.math-display`), which is what KaTeX and
MathJax expect to be handed. The [live demo](https://dangxingyu.github.io/kintsugi-md/) pipes those
nodes through KaTeX in about fifteen lines — see `docs/index.html`.

**Headings** — `##Heading` with no space, seven or more `#`, trailing hash runs, and the
`Title` / `---` ambiguity, where the setext reading wins unless the line above is a finished
sentence or an already-multi-line paragraph. Lowercase titles, `Environment:`, and Chinese or
Japanese titles are headings like any other — a corpus audit showed that guessing from title case
or length destroys far more real headings than it saves.

**Lists** — unicode bullets (`•`, `‣`, `–`), `(1)` and `1)` markers, inconsistent indent widths,
non-sequential numbering, `-[ ]` task boxes glued to the bullet, and `[✓]` / `[✗]` checkboxes.

**Documents** — truncated output of every kind, whole answers wrapped in a code fence (with or
without a "Here's the report:" lead-in), CRLF and mixed line endings, BOMs, zero-width characters,
and non-breaking spaces used as indentation. An unclosed fence stops where markdown structure
plainly resumes, instead of swallowing every section below it.

**Leaked scaffolding** — `<thinking>` blocks and chat control tokens like `<|im_end|>` are
recognized, kept in the AST, and left out of the rendered document unless you ask for them.

**Extensions models reach for that CommonMark lacks** — footnotes (`[^1]` and its definition),
`==highlight==`, GitHub alerts (`> [!WARNING]`), `:::note` admonition containers (auto-closed if
the model forgets), and Pandoc-style definition lists. Markdown inside an HTML callout
(`<div class="warning">`) is parsed rather than left raw.

## What it deliberately does *not* repair

Over-eager repair is the failure mode that makes a tolerant parser worse than a strict one, so the
heuristics are guarded:

- Content inside code fences is never touched. A markdown tutorial that shows broken syntax on
  purpose stays broken on purpose.
- `#1 priority` and `#!/bin/sh` are not headings; `##Results` is.
- `$5 and $10` is currency; `$x^2$` is math.
- A single `|` in a sentence does not make a table — the missing-separator heuristic requires two
  consecutive strongly table-shaped lines with compatible cell counts.
- Unknown angle-bracket tags (`<Component>`, `<placeholder>`) stay visible text rather than being
  swallowed as HTML, so nothing silently disappears.
- Well-formed markdown produces zero diagnostics and the standard CommonMark interpretation.

Two things it will not attempt, on purpose:

- **Whitespace-aligned text is not turned into a table.** A dash underline with visible column gaps
  (`------  ------`) is recognized, because the gaps state where the columns are. Column alignment
  by spaces alone is not, because then any indented block of text would silently become a table.
- **Content is never deleted or reordered.** When a model repeats itself after a retry, both copies
  are kept. The one exception is a header row re-emitted verbatim inside its own table, which is
  dropped as duplicate structure — never as content.

## Performance

Recovery is linear in input size, and the test suite enforces it: eleven adversarial constructs are
each parsed at 4x scale and fail the build if the time grows more than ~8x (quadratic would be 16x).
Measured worst case across every recovery path is a 2.3x cost per doubling, against 2.0x for
perfectly linear. Ordinary documents parse at roughly 8 MB/s.

Keeping that property took real work, and the same bug appeared in several places: a scan that is
individually harmless becomes quadratic when it runs once per delimiter. The engine therefore uses
CommonMark's `openers_bottom` optimization, bounded link-destination scanning, a memoized
end-of-line lookup, and single-pass array rebuilds instead of repeated `splice` calls in the
recovery passes.

## License

MIT
