# Changelog

All notable changes to Kintsugi are recorded here. The AST and diagnostic-code
set are the public surface; changes to either are called out explicitly.

## Unreleased

### Measured

Kintsugi's repair layer was audited against a corpus of 3,090 real GitHub
READMEs (65.5 MB, human-authored, many languages) by sampling repair
diagnostics and judging each against a mainstream CommonMark+GFM parser
(markdown-it). The first audit found the repair layer was **net-negative on
real documents** — 0.16 sample precision, 0.03 weighted by firing volume —
dominated by a handful of heuristics that fired constantly and were almost
always wrong. This release fixes those clusters.

Across three audit rounds, overall sample precision went 0.16 → 0.31 → 0.33
and volume-weighted precision 0.03 → 0.25 → 0.33, with total repairs on the
corpus falling from 12,832 to 1,270. The setext and table families were then
re-judged after their fixes and independently refuted claim-by-claim:

| family | before | after (refutation-verified) |
| --- | --- | --- |
| `setext-vs-break-ambiguity` | 1 true / 21 false | 4 true / 0 false |
| `table-ragged-row` | 1 / 20 | 19 / 5 |
| `table-separator-mismatch` | 0 / 12 | 12 true, 2 harmless, 0 false |
| `table-merged-continuation` | 2 / 23 | 3 / 0 |

Reproduce with `scripts/corpus-check.mjs`, `scripts/audit-sample.mjs`,
`scripts/audit-collect.mjs` and `scripts/audit-report.mjs`.

**Known limitation.** `list-indent-adjusted` is now roughly half of all
remaining false-positive volume, and it is also the least stable measurement
in the audit: two rounds judged comparable samples of the same unchanged
heuristic 2-true/5-false/18-harmless and 8-true/16-false/1-harmless. Treat the
headline precision figure as carrying real error bars until that is resolved.

### Fixed

- **HTML blocks are no longer force-closed at blank lines.** A `<details>` or
  `<table>` with a blank line before its body was getting a spurious closing
  tag that emptied it — affecting 424 of 463 READMEs containing `<details>`.
  A closer is now appended only when the tag is genuinely never closed anywhere
  below it in the document.
- **Emphasis now pairs correctly across word characters.** `a**b**c` and all
  Chinese/Japanese bold text (where every character is "intraword") previously
  failed to pair, and the unclosed-emphasis recovery then bolted the rest of
  the line into `<strong>`. Two root causes fixed: an inclusive `openers_bottom`
  bound (a genuine CommonMark-conformance bug) and ASCII-only punctuation
  classification. Output now matches markdown-it on these cases.
- **`\[` is treated as an escaped literal bracket**, not LaTeX, unless the span
  actually reads as TeX. `\[!TIP]` and `\[[arxiv](url)\]` citations are common
  in real documents and were being eaten as unterminated math.
- **Underscore identifiers survive.** `__stdcall`, `__init__` and similar are no
  longer swallowed as emphasis.
- **Lone unclosed `*` / `_` is left literal** (C pointers, globs, math);
  unclosed-emphasis recovery is restricted to `**` / `__`.
- **Fuzzy code-fence closers yield to a real closer below**, so a `'''`
  docstring inside a ```` ```python ```` block no longer closes it and a
  ```` ```json ```` line that opens the next block is no longer consumed as
  this block's closer.
- **Setext headings are no longer demoted to a paragraph plus a rule.** The
  `Title` / `---` decision used title case, word count, line length, a
  trailing-colon veto, a date veto, and a document-level "this file uses ATX
  headings" signal. Every one of those destroyed real headings — lowercase
  titles, `Environment:`, any CJK title (no ASCII case test can match one), and
  every setext heading in a document that also uses ATX. The CommonMark reading
  now wins unless the line above is a finished sentence or an already-multi-line
  paragraph. Firings fell from 206 to 21 on the corpus.
- **`｜` and `│` are only table delimiters when the row has no ASCII pipe.**
  They are ordinary CJK punctuation and link-list decoration, and promoting
  them inside rows that already used real pipes split cells the author never
  split — which then widened the table, padded the separator, and made every
  row ragged, so one misread produced three different repair diagnostics.
- **Table rows are never folded away.** A row that merely omitted a trailing
  column (`| tesseract-ocr | tesseract.org |` in a 3-column table) was being
  merged into the row above and deleted outright. The wrapped-cell fold now
  requires a line with no cell structure at all.
- **A stray trailing `||` no longer widens a table** or gets merged into a real
  column; GFM ignores the empty cell and so does Kintsugi.

### Changed

- **`bold-line-heading` is now a separate diagnostic code** (was reported under
  `heading-missing-space`) and is **off by default** behind the new
  `promoteBoldHeadings` option. On real documents the promotion invented ~4,000
  headings with no clear wins, and whether a bold line is a heading or emphasis
  is genuinely ambiguous. **New diagnostic code**; existing code
  `heading-missing-space` now covers only the `##Heading`-without-a-space case
  it names.
- **`link-url-spaces` fires only on an interior space in a URL**, not the
  harmless trailing-space-before-`)` case, which renders identically in every
  parser.

### Options added

- `headingDetection: 'rule' | 'auto'` (default `'auto'`) — whether the
  multilingual classifier assists the bold-heading rule in scripts where the
  ASCII title-case signal does not apply.
- `promoteBoldHeadings: boolean` (default `false`) — whether a lone bold line
  may become a heading at all.

### Added earlier in this cycle

- A pinned logistic-regression classifier for the bold-line-as-heading decision
  in Chinese, Japanese, Korean, Arabic and other scripts the ASCII title-case
  rule cannot handle. Deterministic, ~700 bytes, ships in the bundle. See
  `src/classifier.ts` and `src/features.ts`.
- KaTeX typesetting in the landing-page demo.
- Fixes for six crashes, six content-loss bugs and several quadratic paths
  found by adversarial review (`test/adversarial.test.ts`).

## 0.1.0

Initial release: a fault-tolerant markdown parser for LLM output that never
throws, honours evident intent, and logs every repair as a diagnostic.
