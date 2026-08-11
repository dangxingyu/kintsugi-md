import { describe, it, expect } from 'vitest';
import { parse, render } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Triple-backtick fence, built as a constant so template literals stay valid. */
const F = '```';
const F4 = '````';
const F2 = '``';
const T = '~~~';

/** Recursively collect every node of a given type from an AST. */
function collect(node: any, type: string, out: any[] = []): any[] {
  if (node && typeof node === 'object') {
    if (node.type === type) out.push(node);
    for (const key of ['children', 'rows', 'cells']) {
      const kids = node[key];
      if (Array.isArray(kids)) for (const k of kids) collect(k, type, out);
    }
  }
  return out;
}

/** Flatten all inline text under a node. */
function textOf(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'inlineCode') return node.value;
  if (node.type === 'softBreak' || node.type === 'hardBreak') return ' ';
  let out = '';
  for (const key of ['children', 'rows', 'cells']) {
    const kids = node[key];
    if (Array.isArray(kids)) for (const k of kids) out += textOf(k);
  }
  return out;
}

function codes(diagnostics: { code: string }[]): string[] {
  return diagnostics.map((d) => d.code);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every input exercised below, for the never-throws contract test. */
const CORPUS: string[] = [];
function fixture(src: string): string {
  CORPUS.push(src);
  return src;
}

// ---------------------------------------------------------------------------
// 1. Unclosed code fences
// ---------------------------------------------------------------------------

describe('code fences: unclosed at EOF', () => {
  it('closes a truncated python fence at EOF and keeps its body as code', () => {
    const src = fixture(`Here is the fix:

${F}python
def add(a, b):
    return a + b
`);
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('python');
    expect(blocks[0].value).toContain('def add(a, b):');
    expect(blocks[0].value).toContain('return a + b');
    expect(blocks[0].autoClosed).toBe(true);
    expect(codes(diagnostics)).toContain('fence-unclosed');
    expect(render(src).html).toContain('<p>Here is the fix:</p>');
  });

  it('closes a forgotten fence before a following ATX heading instead of eating the rest of the document', () => {
    const src = fixture(`${F}bash
npm install
npm run build

## Next Steps

Now configure the server as described above.`);
    const { ast } = parse(src);
    const { html, diagnostics } = render(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.value).toContain('npm install');
    expect(code.value).not.toContain('Next Steps');
    expect(html).toContain('<h2>Next Steps</h2>');
    expect(html).toContain('<p>Now configure the server as described above.</p>');
    expect(codes(diagnostics)).toContain('fence-unclosed');
  });

  it('closes an unclosed anonymous fence holding config lines', () => {
    const src = fixture(`The config file should look like this:

${F}
host = localhost
port = 8080`);
    const { ast } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.value).toContain('host = localhost');
    expect(code.value).toContain('port = 8080');
    expect(collect(ast, 'paragraph')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Mismatched fence character / length
// ---------------------------------------------------------------------------

describe('code fences: mismatched closer character or length', () => {
  it('accepts a tilde line as the closer of a backtick fence', () => {
    const src = fixture(`${F}python
print('hello')
${T}

That prints a greeting.`);
    const { ast, diagnostics } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.value.trim()).toBe("print('hello')");
    expect(codes(diagnostics)).toContain('fence-mismatched-char');
    expect(render(src).html).toContain('<p>That prints a greeting.</p>');
  });

  it('accepts a shorter backtick run as the closer of a 4-backtick fence', () => {
    const src = fixture(`${F4}text
literal ${F} example
${F}

Done.`);
    const { ast, diagnostics } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.value).toContain(`literal ${F} example`);
    expect(codes(diagnostics)).toContain('fence-mismatched-length');
    const paras = collect(ast, 'paragraph');
    expect(paras.map(textOf)).toContain('Done.');
  });

  it('closes a tilde-opened json fence with a backtick closer', () => {
    const src = fixture(`${T}json
{"a": 1}
${F}`);
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('json');
    expect(blocks[0].value.trim()).toBe('{"a": 1}');
  });

  it('closes a fence whose closer dropped a backtick (only two remain)', () => {
    const src = fixture(`${F}
some code
${F2}

Next paragraph.`);
    const { ast } = parse(src);
    const { html } = render(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value.trim()).toBe('some code');
    expect(html).toContain('<p>Next paragraph.</p>');
  });
});

// ---------------------------------------------------------------------------
// 3. Closing fence with trailing text; malformed info strings
// ---------------------------------------------------------------------------

describe('code fences: closer with info text and malformed info strings', () => {
  it('treats a repeated language tag on the closing fence as the closer, not a new block', () => {
    const src = fixture(`${F}python
print(1)
${F}python

As shown above, this prints 1.`);
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value.trim()).toBe('print(1)');
    expect(render(src).html).toContain('<p>As shown above, this prints 1.</p>');
  });

  it('closes a fence whose closer carries a parenthetical annotation', () => {
    const src = fixture(`${F}sql
SELECT * FROM users;
${F} (end of query)`);
    const { ast } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.lang).toBe('sql');
    expect(code.value.trim()).toBe('SELECT * FROM users;');
    expect(code.value).not.toContain('end of query');
  });

  it('extracts the language from a Pandoc-style braced attribute info string', () => {
    const src = fixture(`${F} {.python .numberLines}
x = 1
${F}`);
    const { ast } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.lang).toBe('python');
    expect(code.value.trim()).toBe('x = 1');
  });

  it('normalizes a "C++ code" info string to the cpp language tag while keeping the raw info', () => {
    const src = fixture(`${F}C++ code
int main() {}
${F}`);
    const { ast } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.lang).toBe('cpp');
    expect(code.info).toContain('C++');
  });

  it('splits a "lang:path" info string into a language plus a preserved file path', () => {
    const src = fixture(`${F}python:app/main.py
app = FastAPI()
${F}`);
    const { ast } = parse(src);
    const [code] = collect(ast, 'codeBlock');
    expect(code.lang).toBe('python');
    expect(code.info).toContain('app/main.py');
  });
});

// ---------------------------------------------------------------------------
// 4. Whole document wrapped in a markdown fence
// ---------------------------------------------------------------------------

describe('code fences: whole-document markdown envelope', () => {
  it('unwraps a ```markdown envelope and parses the report as real markdown', () => {
    const src = fixture(`${F}markdown
# Quarterly Report

## Findings

- Revenue up 12%
- Churn down 3%
${F}`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<h2>Findings</h2>');
    expect(html).toContain('<li>Revenue up 12%</li>');
    expect(html).not.toContain('<pre>');
    expect(codes(diagnostics)).toContain('doc-unwrapped-fence');
  });

  it('unwraps a ```md envelope that follows a one-line preface paragraph', () => {
    const src = fixture(`Here's the README you asked for:

${F}md
# my-tool

Install with \`pip install my-tool\`.
${F}`);
    const { html } = render(src);
    expect(html).toContain("<p>Here's the README you asked for:</p>");
    expect(html).toContain('<h1>my-tool</h1>');
    expect(html).toContain('<code>pip install my-tool</code>');
  });

  it('unwraps an untagged envelope whose body is unmistakably markdown', () => {
    const src = fixture(`${F}
## Setup

1. Clone the repo
2. Run make
${F}`);
    const { html } = render(src);
    expect(html).toContain('<h2>Setup</h2>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>Clone the repo</li>');
  });

  it('GUARD: never unwraps an envelope whose info string is a programming language', () => {
    const src = fixture(`${F}json
{"a": 1, "b": 2}
${F}`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<code class="language-json">');
    expect(html).toContain('&quot;a&quot;: 1');
    expect(codes(diagnostics)).not.toContain('doc-unwrapped-fence');
  });

  it('GUARD: never unwraps an interior markdown fence that is not the whole document', () => {
    const src = fixture(`Compare the two formats:

${F}markdown
# Title

- a
- b
${F}

The HTML version is longer.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<h1>Title</h1>');
    expect(html).toContain('<p>The HTML version is longer.</p>');
    expect(codes(diagnostics)).not.toContain('doc-unwrapped-fence');
  });

  it('GUARD: respects unwrapDocumentFence:false and keeps the envelope as a code block', () => {
    const src = fixture(`${F}markdown
# Quarterly Report

- Revenue up 12%
${F}`);
    const { html } = render(src, { unwrapDocumentFence: false });
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<h1>Quarterly Report</h1>');
  });
});

// ---------------------------------------------------------------------------
// 5. Nested fences
// ---------------------------------------------------------------------------

describe('code fences: nested triple-backtick examples', () => {
  it('pairs the outer markdown fence with the final fence, keeping the inner fence as literal body text', () => {
    const src = fixture(`Format your answer like this:

${F}markdown
# Title

${F}python
print("hi")
${F}
${F}`);
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('# Title');
    expect(blocks[0].value).toContain(`${F}python`);
    expect(blocks[0].value).toContain('print("hi")');
    expect(codes(diagnostics)).not.toContain('fence-unclosed');
  });

  it('does not leave a dangling unclosed block after a nested-fence example', () => {
    const src = fixture(`${F}md
Usage example:

${F}
npm run dev
${F}
${F}`);
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('npm run dev');
    expect(blocks[0].autoClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. ATX heading anomalies
// ---------------------------------------------------------------------------

describe('headings: ATX anomalies', () => {
  it('promotes "#Introduction" (no space after the hash) to an h1', () => {
    const src = fixture(`#Introduction

This report covers the Q3 results.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<h1>Introduction</h1>');
    expect(html).toContain('<p>This report covers the Q3 results.</p>');
    expect(codes(diagnostics)).toContain('heading-missing-space');
  });

  it('strips an unspaced trailing hash run from "##Key Findings##"', () => {
    const src = fixture('##Key Findings##');
    const { ast } = parse(src);
    const [h] = collect(ast, 'heading');
    expect(h.depth).toBe(2);
    expect(textOf(h).trim()).toBe('Key Findings');
  });

  it('clamps a 7-hash heading to depth 6 rather than demoting it to a paragraph', () => {
    const src = fixture('####### Appendix C: Raw Data');
    const { ast, diagnostics } = parse(src);
    const headings = collect(ast, 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].depth).toBe(6);
    expect(textOf(headings[0])).toContain('Appendix C: Raw Data');
    expect(codes(diagnostics)).toContain('heading-depth-clamped');
  });

  it('preserves a stylistic trailing colon in the heading text', () => {
    const src = fixture(`### Results:

The model achieved 94% accuracy.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<h3>Results:</h3>');
    expect(diagnostics).toEqual([]);
  });

  it('GUARD: "The #1 priority is latency." stays a paragraph', () => {
    const src = fixture('The #1 priority is latency.');
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(html).toContain('<p>The #1 priority is latency.</p>');
  });
});

// ---------------------------------------------------------------------------
// 7. Bold line used as a heading
// ---------------------------------------------------------------------------

describe('headings: whole-line bold used as a section header', () => {
  it('promotes a lone bold line to a heading when promoteBoldHeadings is on', () => {
    const src = fixture(`**Section 2: Results**

Accuracy improved across all benchmarks.`);
    const { html } = render(src, { promoteBoldHeadings: true });
    expect(html).toMatch(/<h[1-6]>Section 2: Results<\/h[1-6]>/);
  });

  it('GUARD: leaves that same bold line as emphasis by default (audit showed default-on invents headings)', () => {
    const src = fixture(`**Section 2: Results**

Accuracy improved across all benchmarks.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<strong>Section 2: Results</strong>');
    expect(html).not.toMatch(/<h[1-6]>/);
    expect(diagnostics.filter((d) => d.severity === 'repair')).toEqual([]);
  });

  it('promotes a bold step header with a trailing colon, keeping the numbering cue', () => {
    const src = fixture(`**Step 3 — Deploy the service:**

Run the deploy script with the staging flag.`);
    const { html } = render(src, { promoteBoldHeadings: true });
    expect(html).toMatch(/<h[1-6]>Step 3 — Deploy the service:<\/h[1-6]>/);
    expect(html).toContain('<p>Run the deploy script with the staging flag.</p>');
  });

  it('promotes a bold+italic line used for extra header weight', () => {
    const src = fixture(`***Key Takeaways***

Latency dominates the cost model.`);
    const { ast } = parse(src, { promoteBoldHeadings: true });
    const headings = collect(ast, 'heading');
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0]).trim()).toBe('Key Takeaways');
  });

  it('GUARD: a bold lead-in followed by more text on the same line stays a paragraph', () => {
    const src = fixture('**Warning:** never commit the .env file.');
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(html).toContain('<strong>Warning:</strong>');
    expect(html).toContain('never commit the .env file.');
  });

  it('GUARD: a fully bolded sentence ending in a period stays a paragraph', () => {
    const src = fixture('**We shipped the release on Friday afternoon.**');
    const { ast } = parse(src);
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(collect(ast, 'strong')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Setext underline vs thematic break
// ---------------------------------------------------------------------------

describe('setext vs thematic break', () => {
  it('reads "---" after a full sentence as a horizontal rule, not a setext h2', () => {
    const src = fixture(`That concludes the analysis of the training data.
---
## Evaluation
`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<p>That concludes the analysis of the training data.</p>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<h2>Evaluation</h2>');
    expect(html).not.toContain('<h2>That concludes');
    expect(codes(diagnostics)).toContain('setext-vs-break-ambiguity');
  });

  it('reads a dated line directly over dashes as a heading, not a divider', () => {
    // This path only fires when there is NO blank line before the dashes,
    // which is the setext shape. A model emitting a divider writes a blank
    // line on both sides, and that never reaches here. The old veto on any
    // line containing a date also demoted every heading with a year in it
    // ("Roadmap 2024"), so it is gone.
    const src = fixture(`Report generated on 2026-08-07
----------
All figures are preliminary.`);
    const { html } = render(src);
    expect(html).toContain('<h2>Report generated on 2026-08-07</h2>');
    expect(html).toContain('<p>All figures are preliminary.</p>');
  });

  it('GUARD: a blank-line-delimited "---" is still an unambiguous rule', () => {
    const { html } = render(fixture('Report generated on 2026-08-07\n\n---\n\nAll figures are preliminary.'));
    expect(html).toContain('<hr />');
    expect(html).not.toMatch(/<h[12]>Report generated/);
  });

  it('reads "---" directly after a list as a rule and keeps the list intact', () => {
    const src = fixture(`- item one
- item two
---
Next section`);
    const { html } = render(src);
    expect(html).toContain('<li>item one</li>');
    expect(html).toContain('<li>item two</li>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Next section</p>');
  });

  it('keeps the "=" form as a genuine setext h1', () => {
    const src = fixture(`Overview
========

This document describes the system.`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(html).toContain('<h1>Overview</h1>');
    const [h] = collect(ast, 'heading');
    expect(h.setext).toBe(true);
    expect(html).not.toContain('<hr />');
  });

  it('repairs a two-dash divider into a horizontal rule instead of a setext heading', () => {
    const src = fixture(`First paragraph.
--
Second paragraph.`);
    const { html } = render(src);
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Second paragraph.</p>');
    expect(html).not.toContain('<h2>First paragraph.</h2>');
  });

  it('GUARD: a "---" surrounded by blank lines is an ordinary thematic break with no repair', () => {
    const src = fixture(`Above.

---

Below.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<hr />');
    expect(diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. YAML frontmatter
// ---------------------------------------------------------------------------

describe('frontmatter', () => {
  it('parses standard top-of-document frontmatter as a metadata block, not hr + setext soup', () => {
    const src = fixture(`---
title: Q3 Incident Report
author: assistant
date: 2026-08-07
---

# Summary`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(ast.children[0]!.type).toBe('frontmatter');
    expect((ast.children[0] as any).value).toContain('title: Q3 Incident Report');
    expect((ast.children[0] as any).value).toContain('date: 2026-08-07');
    expect(html).toContain('<h1>Summary</h1>');
    expect(html).not.toContain('<hr />');
    expect(html).not.toContain('<h2>');
  });

  it('auto-closes unclosed frontmatter at the first non-YAML line', () => {
    const src = fixture(`---
title: Deployment Guide
tags: [ops, k8s]

# Overview

This guide covers...`);
    const { ast, html, diagnostics } = { ...parse(src), html: render(src).html };
    const fm = collect(ast, 'frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].value).toContain('title: Deployment Guide');
    expect(html).toContain('<h1>Overview</h1>');
    expect(html).not.toContain('<hr />');
    expect(codes(diagnostics)).toContain('frontmatter-unclosed');
  });

  it('keeps a leading ```yaml metadata fence as a code block and parses the document after it', () => {
    const src = fixture(`${F}yaml
title: My Post
draft: true
${F}

# My Post

Body text.`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const [code] = collect(ast, 'codeBlock');
    expect(code.lang).toBe('yaml');
    expect(code.value).toContain('draft: true');
    expect(html).toContain('<h1>My Post</h1>');
    expect(html).toContain('<p>Body text.</p>');
  });

  it('keeps mid-document metadata content visible rather than turning it into a setext heading', () => {
    const src = fixture(`Some intro text.

---
status: draft
reviewed_by: none
---

More text.`);
    const { html } = render(src);
    expect(html).toContain('status: draft');
    expect(html).toContain('reviewed_by: none');
    expect(html).toContain('<p>More text.</p>');
    expect(html).not.toMatch(/<h[12]>status: draft/);
  });
});

// ---------------------------------------------------------------------------
// 10. Blockquote anomalies
// ---------------------------------------------------------------------------

describe('blockquotes', () => {
  it('accepts ">" with no following space as a quote marker', () => {
    const src = fixture('>Note: this endpoint is rate-limited.');
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'blockquote')).toHaveLength(1);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('Note: this endpoint is rate-limited.');
  });

  it('absorbs a markerless middle line into the surrounding blockquote', () => {
    const src = fixture(`> The paper argues that scaling laws
hold across modalities
> and concludes with open problems.`);
    const { ast } = parse(src);
    const quotes = collect(ast, 'blockquote');
    expect(quotes).toHaveLength(1);
    const t = textOf(quotes[0]);
    expect(t).toContain('The paper argues that scaling laws');
    expect(t).toContain('hold across modalities');
    expect(t).toContain('and concludes with open problems');
  });

  it('keeps both halves of a blank-line-split quote inside blockquote markup', () => {
    const src = fixture(`> First, the author establishes the baseline.

> Then the ablations remove each component in turn.`);
    const { ast } = parse(src);
    // Neither half may escape into a top-level paragraph.
    expect(ast.children.every((b: any) => b.type === 'blockquote')).toBe(true);
    const quoted = collect(ast, 'blockquote').map(textOf).join(' ');
    expect(quoted).toContain('First, the author establishes the baseline.');
    expect(quoted).toContain('Then the ablations remove each component in turn.');
  });

  it('reads ">>" without spaces as a nested quote level', () => {
    const src = fixture(`>>Nested reply without spaces
>Outer level`);
    const { html } = render(src);
    expect(count(html, '<blockquote>')).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Nested reply without spaces');
    expect(html).toContain('Outer level');
  });

  it('GUARD: a well-formed multi-line blockquote is not repaired', () => {
    const src = fixture(`> The first line of the quote.
> The second line of the quote.`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<blockquote>');
    expect(diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 11. Indented-code false positives
// ---------------------------------------------------------------------------

describe('indented chunks that are prose, not code', () => {
  it('treats an indented quoted sentence as prose rather than a code block', () => {
    const src = fixture(`The reviewer's key comment:

    The methodology section needs a power analysis before the results can be trusted.

We agree and will add one.`);
    const { html, diagnostics } = render(src);
    expect(html).not.toContain('<pre>');
    expect(html).toContain('The methodology section needs a power analysis');
    expect(html).toContain('<p>We agree and will add one.</p>');
    expect(codes(diagnostics)).toContain('indented-prose-not-code');
  });

  it('keeps an over-indented continuation paragraph inside its list item', () => {
    const src = fixture(`- Configure the database

      This step requires admin credentials and takes about five minutes.`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(html).not.toContain('<pre>');
    const items = collect(ast, 'listItem');
    expect(items).toHaveLength(1);
    expect(textOf(items[0])).toContain('This step requires admin credentials');
  });

  it('treats an indented letter-style paragraph as prose', () => {
    const src = fixture(`Dear team,

    We are pleased to announce the v2 launch.
    Rollout begins Monday.

Best,
Ops`);
    const { html } = render(src);
    expect(html).not.toContain('<pre>');
    expect(html).toContain('We are pleased to announce the v2 launch.');
    expect(html).toContain('Rollout begins Monday.');
  });

  it('GUARD: prose inside a fenced block stays code no matter how English it reads', () => {
    const src = fixture(`${F}
The methodology section needs a power analysis before the results can be trusted.
${F}`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<pre>');
    expect(codes(diagnostics)).not.toContain('indented-prose-not-code');
  });
});

// ---------------------------------------------------------------------------
// 12. LaTeX display math blocks
// ---------------------------------------------------------------------------

describe('display math blocks', () => {
  it('captures a \\[ ... \\] block verbatim, with backslashes and subscripts intact', () => {
    const src = fixture(String.raw`The loss is defined as:

\[
L = -\sum_{i} y_i \log \hat{y}_i
\]

where y is the label.`);
    const { ast } = parse(src);
    const maths = collect(ast, 'mathBlock');
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toContain(String.raw`\sum_{i}`);
    expect(maths[0].value).toContain(String.raw`\hat{y}_i`);
    expect(maths[0].value).toContain(String.raw`\log`);
  });

  it('does not let underscores inside display math become emphasis, and keeps the surrounding prose', () => {
    const src = String.raw`The loss is defined as:

\[
L = -\sum_{i} y_i \log \hat{y}_i
\]

where y is the label.`;
    const { html } = render(src);
    expect(html).not.toContain('<em>');
    expect(html).toContain('<p>The loss is defined as:</p>');
    expect(html).toContain('<p>where y is the label.</p>');
  });

  it('captures a multi-line $$ ... $$ block', () => {
    const src = fixture(String.raw`$$
\frac{\partial L}{\partial w} = x (\hat{y} - y)
$$`);
    const { ast } = parse(src);
    const maths = collect(ast, 'mathBlock');
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toContain(String.raw`\frac{\partial L}{\partial w}`);
  });

  it('captures a one-line $$...$$ block as its own math block', () => {
    const src = fixture('$$E = mc^2$$');
    const { ast } = parse(src);
    const maths = collect(ast, 'mathBlock');
    expect(maths).toHaveLength(1);
    expect(maths[0].value.trim()).toBe('E = mc^2');
  });

  it('auto-closes an unclosed $$ block at the blank line so the following prose survives', () => {
    const src = fixture(String.raw`$$
x_{t+1} = x_t - \eta \nabla f(x_t)

We then iterate until convergence.`);
    const { ast, html, diagnostics } = { ...parse(src), html: render(src).html };
    const maths = collect(ast, 'mathBlock');
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toContain(String.raw`\eta \nabla f(x_t)`);
    expect(html).toContain('<p>We then iterate until convergence.</p>');
    expect(codes(diagnostics)).toContain('math-auto-closed');
  });

  it('captures a bare \\begin{align} ... \\end{align} environment as display math', () => {
    const src = fixture(String.raw`\begin{align}
a &= b + c \\
d &= e
\end{align}`);
    const { ast } = parse(src);
    const maths = collect(ast, 'mathBlock');
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toContain('a &= b + c');
    expect(maths[0].value).toContain('d &= e');
  });

  it('GUARD: "$5 and $10" is currency, not math', () => {
    const src = fixture('The tickets cost $5 and $10 respectively.');
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'mathBlock')).toHaveLength(0);
    expect(collect(ast, 'inlineMath')).toHaveLength(0);
    expect(html).toContain('$5 and $10');
  });

  it('GUARD: spaced arithmetic "a * b * c" is not emphasis', () => {
    const src = fixture('The product is written a * b * c in the paper.');
    const { html } = render(src);
    expect(html).not.toContain('<em>');
    expect(html).toContain('a * b * c');
  });
});

// ---------------------------------------------------------------------------
// 13. Table structure errors
// ---------------------------------------------------------------------------

describe('tables', () => {
  it('treats the first row as a header when the delimiter row is missing', () => {
    const src = fixture(`| Model | Accuracy |
| GPT-X | 91.2 |
| Claude | 93.4 |`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<table>');
    expect(html).toMatch(/<th[^>]*>Model<\/th>/);
    expect(html).toMatch(/<td[^>]*>GPT-X<\/td>/);
    expect(html).toMatch(/<td[^>]*>Claude<\/td>/);
    expect(codes(diagnostics)).toContain('table-missing-separator');
  });

  it('normalizes ragged rows without silently dropping the overflow cell', () => {
    const src = fixture(`| A | B | C |
|---|---|
| 1 | 2 | 3 | 4 |`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<table>');
    expect(html).toMatch(/<th[^>]*>A<\/th>/);
    expect(html).toMatch(/<th[^>]*>C<\/th>/);
    expect(html).toContain('4');
    expect(codes(diagnostics).some((c) => c === 'table-ragged-row' || c === 'table-separator-mismatch')).toBe(true);
  });

  it('lets a table start immediately after a paragraph line with no blank line between', () => {
    const src = fixture(`The results are summarized below:
| Metric | Value |
|--------|-------|
| F1 | 0.87 |`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<p>The results are summarized below:</p>');
    expect(html).toContain('<table>');
    expect(html).toMatch(/<th[^>]*>Metric<\/th>/);
    expect(html).toMatch(/<td[^>]*>0.87<\/td>/);
    expect(codes(diagnostics)).toContain('table-interrupts-paragraph');
  });

  it('recognizes a bolded first row as the header when edge pipes and delimiter are absent', () => {
    const src = fixture(`**Name** | **Role**
Alice | Engineer
Bob | Designer`);
    const { html } = render(src);
    expect(html).toContain('<table>');
    expect(html).toMatch(/<th[^>]*><strong>Name<\/strong><\/th>/);
    expect(html).toMatch(/<td[^>]*>Alice<\/td>/);
    expect(html).toMatch(/<td[^>]*>Designer<\/td>/);
  });

  it('reads alignment colons even when the delimiter row lost its trailing pipe', () => {
    const src = fixture(`| Col A | Col B |
| :--- | ---:
| left | right |`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const [table] = collect(ast, 'table');
    expect(table).toBeDefined();
    expect(table.align).toEqual(['left', 'right']);
    expect(html).toContain('text-align:left');
    expect(html).toContain('text-align:right');
  });

  it('GUARD: a well-formed GFM table produces no repairs', () => {
    const src = fixture(`| Metric | Value |
| --- | --- |
| F1 | 0.87 |`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<table>');
    expect(diagnostics).toEqual([]);
  });

  it('GUARD: a sentence containing a pipe character is not a table', () => {
    const src = fixture('Use the | operator to pipe output into the next command.');
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'table')).toHaveLength(0);
    expect(html).toContain('<p>Use the | operator to pipe output into the next command.</p>');
  });
});

// ---------------------------------------------------------------------------
// 14. List structure errors
// ---------------------------------------------------------------------------

describe('lists', () => {
  it('nests 2-space-indented bullets under an ordered parent instead of flattening them', () => {
    const src = fixture(`1. Fruits
  - apple
  - banana
2. Vegetables`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const topLists = ast.children.filter((b: any) => b.type === 'list');
    expect(topLists).toHaveLength(1);
    expect((topLists[0] as any).children).toHaveLength(2);
    expect(collect(topLists[0], 'list').length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>apple</li>');
  });

  it('lets an ordered list starting at 2 interrupt a paragraph, preserving the start number', () => {
    const src = fixture(`The options are as follows:
2. Use the managed service
3. Self-host the cluster`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(html).toContain('<p>The options are as follows:</p>');
    const [list] = collect(ast, 'list');
    expect(list).toBeDefined();
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(2);
    expect(list.children).toHaveLength(2);
  });

  it('keeps a bullet list whose marker character wobbles as one list', () => {
    const src = fixture(`- first point
* second point
- third point`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const lists = ast.children.filter((b: any) => b.type === 'list');
    expect(lists).toHaveLength(1);
    expect((lists[0] as any).children).toHaveLength(3);
    expect(count(html, '<ul>')).toBe(1);
  });

  it('treats all-1 ordered numbering as a normal 3-item ordered list', () => {
    const src = fixture(`1. Download the installer
1. Run it
1. Restart`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const [list] = collect(ast, 'list');
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(1);
    expect(list.children).toHaveLength(3);
    expect(count(html, '<li>')).toBe(3);
  });

  it('adopts an under-indented explanation paragraph into the preceding list item', () => {
    const src = fixture(`1. Configure DNS

  This requires access to the registrar.

2. Issue certificates`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    const topLists = ast.children.filter((b: any) => b.type === 'list');
    expect(topLists).toHaveLength(1);
    expect((topLists[0] as any).children).toHaveLength(2);
    expect(textOf((topLists[0] as any).children[0])).toContain('This requires access to the registrar.');
    expect(html).not.toContain('<ol start="2">');
  });

  it('GUARD: a well-formed nested list is not repaired', () => {
    const src = fixture(`- Fruits
  - apple
  - banana
- Vegetables`);
    const { html, diagnostics } = render(src);
    expect(html).toContain('<li>apple</li>');
    expect(diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 15. HTML blocks and angle-bracket placeholders
// ---------------------------------------------------------------------------

describe('HTML blocks and angle-bracket placeholders', () => {
  it('renders a <your-token-here> placeholder as literal text without swallowing the next line', () => {
    const src = fixture(`Set the Authorization header to:
<your-token-here>
and retry the request.`);
    const { html } = render(src);
    expect(html).toContain('&lt;your-token-here&gt;');
    expect(html).toContain('and retry the request.');
  });

  it('does not lose the heading and prose after an unclosed <details> block', () => {
    const src = fixture(`<details>
<summary>Full stack trace</summary>
Traceback (most recent call last):
  ...

## Root Cause

The pool exhausted its connections.`);
    const { html } = render(src);
    expect(html).toContain('<h2>Root Cause</h2>');
    expect(html).toContain('<p>The pool exhausted its connections.</p>');
  });

  it('auto-closes an unclosed <details> container so the output is balanced HTML', () => {
    const src = fixture(`<details>
<summary>Full stack trace</summary>
Traceback (most recent call last):
  ...

## Root Cause

The pool exhausted its connections.`);
    const { html } = render(src);
    expect(html).toContain('</details>');
  });

  it('starts the document proper at "# Answer" when reasoning tags leak in', () => {
    const src = fixture(`<think>
The user probably wants JSON output.
</think>
# Answer

Here is the config.`);
    const { html } = render(src);
    expect(html).toContain('<h1>Answer</h1>');
    expect(html).toContain('<p>Here is the config.</p>');
  });

  it('keeps an inline <config.yaml> placeholder as visible literal text', () => {
    const src = fixture('Paste this into <config.yaml> before deploying.');
    const { html } = render(src);
    expect(html).toContain('&lt;config.yaml&gt;');
    expect(html).toContain('before deploying');
  });

  it('GUARD: a real, closed HTML block passes through untouched', () => {
    const src = fixture(`<div align="center">
  <img src="logo.png" alt="logo" />
</div>`);
    const { ast, html } = { ast: parse(src).ast, html: render(src).html };
    expect(collect(ast, 'htmlBlock')).toHaveLength(1);
    expect(html).toContain('<div align="center">');
    expect(html).toContain('</div>');
  });

  it('GUARD: a fenced tutorial showing literal markdown syntax stays code', () => {
    const src = fixture(`Here is how to write a heading:

${F}text
# Heading One
- list item
> a quote
${F}

That is the syntax.`);
    const { html } = render(src);
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<blockquote>');
    expect(html).toContain('# Heading One');
    expect(html).toContain('<p>That is the syntax.</p>');
  });
});

// ---------------------------------------------------------------------------
// Contract: parsing never throws, always yields a Document
// ---------------------------------------------------------------------------

describe('contract: never throws, always returns a document', () => {
  it('returns a document for every taxonomy fixture in this suite', () => {
    expect(CORPUS.length).toBeGreaterThan(30);
    for (const src of CORPUS) {
      const result = parse(src);
      expect(result.ast.type).toBe('document');
      expect(Array.isArray(result.ast.children)).toBe(true);
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(() => render(src)).not.toThrow();
      expect(typeof render(src).html).toBe('string');
    }
  });

  it('returns a document for pathological block-level inputs', () => {
    const nasty = [
      '',
      '\n\n\n',
      F,
      `${F}${F}${F}`,
      '---',
      '---\n',
      '>',
      '>>>>',
      '#',
      '#######',
      '$$',
      '\\[',
      '<details>',
      '|',
      '| | |',
      '    ',
      '\u{FEFF}# BOM heading',
      `${F}markdown`,
      `${T}\n${F}`,
      'a\n---\n---\n---',
    ];
    for (const src of nasty) {
      const result = parse(src);
      expect(result.ast.type).toBe('document');
      expect(() => render(src)).not.toThrow();
    }
  });
});
