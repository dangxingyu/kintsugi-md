import { describe, it, expect } from 'vitest';
import { parse, render } from '../src/index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build multi-line markdown without fighting backticks inside template literals. */
const md = (...lines: string[]): string => lines.join('\n');

const codes = (diagnostics: { code: string }[]): string[] => diagnostics.map((d) => d.code);

const KIDS = ['children', 'rows', 'cells'] as const;

/** Collect every node of a given type anywhere in the tree. */
function collect(node: any, type: string, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  for (const key of KIDS) if (Array.isArray(node[key])) collect(node[key], type, out);
  return out;
}

/** Deepest nesting count of `type` along any single root-to-leaf path. */
function maxNesting(node: any, type: string, depth = 0): number {
  if (node === null || node === undefined || typeof node !== 'object') return depth;
  const here = node.type === type ? depth + 1 : depth;
  let best = here;
  for (const key of KIDS) {
    const kids = node[key];
    if (Array.isArray(kids)) for (const k of kids) best = Math.max(best, maxNesting(k, type, here));
  }
  return best;
}

/** Concatenated text payload of a subtree (code/math values included). */
function textOf(node: any): string {
  if (node === null || node === undefined || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.value === 'string') return node.value;
  let s = '';
  for (const key of KIDS) if (Array.isArray(node[key])) s += textOf(node[key]) + ' ';
  return s;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const BOM = '﻿';
const NBSP = ' ';
const ZWSP = '​';

// ===========================================================================
// 1. truncated-output — the document stops mid-construct
// ===========================================================================

describe('truncated output: document ends mid-construct', () => {
  const truncatedFence = md(
    '## Deployment',
    '',
    'Run the migration job first:',
    '',
    '```bash',
    'kubectl apply -f migrations/',
    'kubectl rollout status deploy/api --time',
  );

  it('keeps everything after an unclosed fence opener inside the code block', () => {
    const { ast, diagnostics } = parse(truncatedFence);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('bash');
    expect(blocks[0].value).toContain('kubectl apply -f migrations/');
    expect(blocks[0].value).toContain('kubectl rollout status deploy/api --time');
    expect(codes(diagnostics)).toContain('fence-unclosed');
  });

  it('marks the auto-closed fence so consumers can see the tail was truncated', () => {
    const { ast } = parse(truncatedFence);
    expect(collect(ast, 'codeBlock')[0].autoClosed).toBe(true);
  });

  it('does not leak the tail of a truncated fence into rendered prose', () => {
    const { html } = render(truncatedFence);
    expect(html).toContain('<h2>Deployment</h2>');
    expect(html).not.toContain('<p>kubectl');
  });

  it('keeps the partial final row of a table that was cut off mid-cell', () => {
    const { html } = render(
      md(
        '| Region    | Instances | Monthly cost |',
        '|-----------|-----------|--------------|',
        '| us-east-1 | 12        | $4,320       |',
        '| eu-west-1 | 8         | $2,9',
      ),
    );
    expect(html).toContain('<th>Region</th>');
    expect(html).toContain('<td>us-east-1</td>');
    expect(html).toContain('<td>eu-west-1</td>');
    expect(html).toContain('$2,9');
  });

  it('synthesizes a close for bold that was cut off mid-sentence', () => {
    const { html, diagnostics } = render('The single most important property is **idempotency: retries must not');
    expect(html).toContain('<strong>');
    expect(html).toContain('idempotency');
    expect(html).not.toContain('**');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });

  it('keeps a link whose URL was truncated as a link, not literal brackets', () => {
    const { html, diagnostics } = render('3. Configure the webhook endpoint ([see docs](https://api.example.com/v2/web');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('href="https://api.example.com/v2/web"');
    expect(html).toContain('see docs</a>');
    expect(codes(diagnostics)).toContain('link-unclosed');
  });

  it('leaves an unclosed fence open only at EOF, never at the next blank line', () => {
    const { ast } = parse(
      md('```python', 'def f():', '', '    return 1', '', 'This trailing prose was swallowed by the fence.'),
    );
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('This trailing prose was swallowed by the fence.');
    expect(collect(ast, 'paragraph')).toHaveLength(0);
  });
});

// ===========================================================================
// 2. full-document-fence-wrap
// ===========================================================================

describe('whole-document fence wrapping', () => {
  it('unwraps a ```markdown fence that packages the entire answer', () => {
    const src = md(
      '```markdown',
      '# Q3 Incident Report',
      '',
      '## Summary',
      'On 2026-07-14 the payments API returned elevated 5xx for 41 minutes.',
      '',
      '## Timeline',
      '- 14:02 UTC: alerts fire',
      '- 14:09 UTC: rollback initiated',
      '```',
    );
    const { html, diagnostics } = render(src);
    expect(html).toContain('<h1>Q3 Incident Report</h1>');
    expect(html).toContain('<h2>Timeline</h2>');
    expect(html).toContain('<li>14:02 UTC: alerts fire</li>');
    expect(html).not.toContain('<pre>');
    expect(codes(diagnostics)).toContain('doc-unwrapped-fence');
  });

  it('does NOT unwrap a bare fence whose content is a single foreign language (docker-compose)', () => {
    const src = md(
      '```',
      'services:',
      '  api:',
      '    image: acme/api:1.4',
      '    ports:',
      '      - "8080:8080"',
      '```',
    );
    const { html, diagnostics } = render(src);
    expect(html).toContain('<pre>');
    expect(html).toContain('services:');
    expect(html).not.toContain('<li>');
    expect(codes(diagnostics)).not.toContain('doc-unwrapped-fence');
  });

  it('unwraps a truncated markdown wrapper without mistaking an inner fence for the outer closer', () => {
    const src = md(
      '```markdown',
      '# Migration Guide',
      '',
      '## Step 1',
      'Back up the database:',
      '',
      '```sh',
      'pg_dump prod > backup.sql',
      '```',
    );
    const { ast } = parse(src);
    const headings = collect(ast, 'heading');
    expect(headings.map((h) => textOf(h).trim())).toEqual(['Migration Guide', 'Step 1']);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('sh');
    expect(blocks[0].value).toContain('pg_dump prod > backup.sql');
  });

  it('honors unwrapDocumentFence:false and keeps the wrapper as a code block', () => {
    const src = md('```markdown', '# Title', '', '- one', '- two', '```');
    const { ast } = parse(src, { unwrapDocumentFence: false });
    expect(collect(ast, 'codeBlock')).toHaveLength(1);
    expect(collect(ast, 'heading')).toHaveLength(0);
  });

  it('does not unwrap a fence that is only part of the document', () => {
    const src = md('Here is the plan:', '', '```markdown', '# Not the whole doc', '- a', '- b', '```', '', 'Thanks!');
    const { ast, diagnostics } = parse(src);
    expect(collect(ast, 'codeBlock')).toHaveLength(1);
    expect(codes(diagnostics)).not.toContain('doc-unwrapped-fence');
  });
});

// ===========================================================================
// 3. markdown-teaching-material — brokenness is the point
// ===========================================================================

describe('markdown-about-markdown: intentionally broken examples', () => {
  it('does not turn inline mentions of #Heading syntax into headings', () => {
    const src = 'A common mistake is writing #Heading without a space after the hash. Change #Heading to # Heading and it will render.';
    const { ast, diagnostics } = parse(src);
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(collect(ast, 'paragraph')).toHaveLength(1);
    expect(codes(diagnostics)).not.toContain('heading-missing-space');
  });

  // DECLINED: knowing an example is broken *on purpose* requires reading the
  // surrounding prose. Guessing at that would make every repair unpredictable,
  // so Kintsugi only exempts content inside code fences. See README non-goals.
  it.skip('does not repair a table that the surrounding prose presents as broken on purpose', () => {
    const src = md(
      'If you forget the delimiter row, the table will not render:',
      '',
      '| Name | Role |',
      '| Ada | Engineer |',
      '',
      'Add a `|------|------|` line after the header to fix it.',
    );
    const { html, diagnostics } = render(src);
    expect(html).not.toContain('<table>');
    expect(html).toContain('| Name | Role |');
    expect(codes(diagnostics)).not.toContain('table-missing-separator');
  });

  it('renders a delimiter-row example inside a code span literally', () => {
    const { html } = render('Add a `|------|------|` line after the header to fix it.');
    expect(html).toContain('<code>|------|------|</code>');
    expect(html).not.toContain('<table>');
  });

  it('never repairs syntax shown inside a fenced code block', () => {
    const src = md(
      'Bad markdown looks like this:',
      '',
      '```',
      '#Heading',
      '| Name | Role |',
      '**unclosed bold',
      '```',
    );
    const { ast, diagnostics } = parse(src);
    const block = collect(ast, 'codeBlock')[0];
    expect(block.value).toContain('#Heading');
    expect(block.value).toContain('| Name | Role |');
    expect(block.value).toContain('**unclosed bold');
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(collect(ast, 'table')).toHaveLength(0);
    expect(codes(diagnostics)).not.toContain('heading-missing-space');
    expect(codes(diagnostics)).not.toContain('emphasis-auto-closed');
  });

  // DECLINED: same reason — depends on prose describing the example as an example.
  it.skip('treats an inner python fence shown as an example as display text, keeping the trailing prose as prose', () => {
    const src = md(
      "Here's how to show a code block in your README:",
      '',
      '```',
      '```python',
      'print("hi")',
      '```',
      '```',
      '',
      "Commit that and you're done.",
    );
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('```python');
    expect(blocks[0].value).toContain('print("hi")');
    const paragraphs = collect(ast, 'paragraph');
    expect(textOf(paragraphs[paragraphs.length - 1])).toContain("Commit that and you're done.");
  });

  // DECLINED: same reason — requires understanding prose that labels the
  // adjacent markup as deliberately wrong.
  it.skip('does not auto-close emphasis that prose explicitly labels as a mistake', () => {
    const src = md(
      'A common mistake in markdown syntax: forgetting the closing asterisks, for example',
      '',
      '**bold text that never closes',
      '',
      'which will not render as bold.',
    );
    const { diagnostics } = render(src);
    expect(codes(diagnostics)).not.toContain('emphasis-auto-closed');
  });
});

// ===========================================================================
// 4. chat-scaffolding-artifacts
// ===========================================================================

describe('chat frame leakage', () => {
  const framed = md(
    "Sure! Here's the complete `docker-compose.yml` with the healthcheck added:",
    '',
    '```yaml',
    'services:',
    '  api:',
    '    image: acme/api:1.4',
    '    healthcheck:',
    '      test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]',
    '```',
    '',
    "Let me know if you'd also like a staging profile!",
  );

  it('keeps the deliverable code block intact when it is surrounded by chat frame prose', () => {
    const { ast } = parse(framed);
    const block = collect(ast, 'codeBlock')[0];
    expect(block.lang).toBe('yaml');
    expect(block.value).toContain('healthcheck:');
    expect(block.value).toContain('http://localhost:8080/healthz');
  });

  it('keeps chat frame paragraphs in the default rendering rather than deleting prose', () => {
    const { html } = render(framed);
    expect(html).toContain('Sure!');
    expect(html).toContain('staging profile');
  });

  it('does not let a leaked <thinking> block swallow the document that follows it', () => {
    const src = md(
      '<thinking>',
      'The user wants the summary as a table, so I should include columns for owner and ETA.',
      '</thinking>',
      '',
      '# Sprint Summary',
      '',
      '| Task | Owner | ETA |',
      '|------|-------|-----|',
      '| Auth refactor | Dana | Fri |',
    );
    const { html } = render(src);
    expect(html).toContain('<h1>Sprint Summary</h1>');
    expect(html).toContain('<th>Owner</th>');
    expect(html).toContain('<td>Dana</td>');
  });

  it('excludes leaked reasoning inside <thinking> from the rendered output', () => {
    const src = md(
      '<thinking>',
      'The user wants the summary as a table, so I should include columns for owner and ETA.',
      '</thinking>',
      '',
      '# Sprint Summary',
    );
    const { html } = render(src);
    expect(html).not.toContain('The user wants the summary as a table');
    expect(html).toContain('<h1>Sprint Summary</h1>');
  });

  it('does not render trailing serialization leakage as document content', () => {
    const src = md('# Weekly Report', '', 'All deploys green; error budget at 94%.', '</output><|im_end|>');
    const { html } = render(src);
    expect(html).toContain('<h1>Weekly Report</h1>');
    expect(html).toContain('error budget at 94%');
    expect(html).not.toContain('im_end');
  });

  it('never strips control tokens that appear inside a code fence', () => {
    const src = md(
      'The chat-ML wire format looks like this:',
      '',
      '```text',
      '<|im_start|>user',
      'hello',
      '<|im_end|>',
      '```',
    );
    const { ast } = parse(src);
    const block = collect(ast, 'codeBlock')[0];
    expect(block.value).toContain('<|im_start|>user');
    expect(block.value).toContain('<|im_end|>');
  });
});

// ===========================================================================
// 5. mislabeled-fence-info
// ===========================================================================

describe('wrong or malformed fence info strings', () => {
  it('never alters fence content when the declared language is wrong', () => {
    const src = md(
      '```json',
      'name: deploy',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '```',
    );
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.fenced).toBe(true);
    expect(block.value).toContain('runs-on: ubuntu-latest');
    expect(block.value).toContain('branches: [main]');
    expect(block.value).not.toContain('```');
  });

  it('relabels a json-tagged fence whose content is unmistakably YAML', () => {
    const src = md('```json', 'name: deploy', 'on:', '  push:', '    branches: [main]', '```');
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.lang).toBe('yaml');
  });

  it('normalizes language aliases while preserving the raw info string', () => {
    const src = md('```yml', 'a: 1', '```');
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.info).toBe('yml');
    expect(block.lang).toBe('yaml');
  });

  it('takes only the language token from a decorated info string', () => {
    const src = md('```python copy code', 'print(1)', '```');
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.lang).toBe('python');
    expect(block.value.trim()).toBe('print(1)');
  });

  it('treats triple apostrophes as fence markers when they come in a matching pair', () => {
    const src = md("'''python", 'import os', 'print(os.environ["HOME"])', "'''");
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('python');
    expect(blocks[0].value).toContain('import os');
    expect(blocks[0].value).not.toContain("'''");
  });

  it('hoists a language token that slid onto the first content line', () => {
    const src = md('```', 'python', 'for i in range(3):', '    print(i)', '```');
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.lang).toBe('python');
    expect(block.value.startsWith('python')).toBe(false);
    expect(block.value).toContain('for i in range(3):');
  });

  it('leaves a correctly labelled JSON fence completely alone', () => {
    const src = md('```json', '{', '  "retries": 3,', '  "timeout": "30s"', '}', '```');
    const { ast, diagnostics } = parse(src);
    const block = collect(ast, 'codeBlock')[0];
    expect(block.lang).toBe('json');
    expect(block.value).toContain('"retries": 3,');
    expect(diagnostics).toHaveLength(0);
  });

  it('does not hoist a first line that merely happens to be a word', () => {
    const src = md('```', 'python', 'is a great language for scripting and data work.', '```');
    const block = collect(parse(src).ast, 'codeBlock')[0];
    expect(block.value).toContain('python');
    expect(block.lang).toBe('');
  });
});

// ===========================================================================
// 6. nested-fence-collision
// ===========================================================================

describe('fence-in-fence with equal markers', () => {
  it('keeps an inner ```sh block inside the outer ```md fence and the trailing line as prose', () => {
    const src = md(
      'Add this section to your README:',
      '',
      '```md',
      '## Install',
      '',
      '```sh',
      'npm i @acme/toolkit',
      '```',
      '```',
      '',
      'Then commit the change.',
    );
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('md');
    expect(blocks[0].value).toContain('## Install');
    expect(blocks[0].value).toContain('```sh');
    expect(blocks[0].value).toContain('npm i @acme/toolkit');
    const paragraphs = collect(ast, 'paragraph');
    expect(textOf(paragraphs[paragraphs.length - 1])).toContain('Then commit the change.');
  });

  it('does not invert code/prose parity when a bare fence wraps a fenced template', () => {
    const src = md('```', 'Here is the template:', '```', 'You are a helpful assistant.', 'Respond in JSON.', '```', '```');
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('You are a helpful assistant.');
    expect(blocks[0].value).toContain('Respond in JSON.');
    const proseText = collect(ast, 'paragraph').map(textOf).join(' ');
    expect(proseText).not.toContain('You are a helpful assistant.');
  });

  it('parses the correct 4-backtick idiom per spec with no repair diagnostics', () => {
    const src = md(
      'Here is a README snippet:',
      '',
      '````md',
      '# Title',
      '',
      '```js',
      'console.log(1)',
      '```',
      '````',
      '',
      'Done.',
    );
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('md');
    expect(blocks[0].value).toContain('```js');
    expect(collect(ast, 'heading')).toHaveLength(0);
    expect(diagnostics.filter((d) => d.severity === 'repair')).toEqual([]);
  });

  it('does not merge two ordinary sibling fences separated by prose', () => {
    const src = md('```js', 'const a = 1;', '```', '', 'And in Python:', '', '```py', 'a = 1', '```');
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].value.trim()).toBe('const a = 1;');
    expect(blocks[1].value.trim()).toBe('a = 1');
    expect(codes(diagnostics)).not.toContain('fence-unclosed');
  });

  it('keeps the remainder of the document out of code after a nested-fence example', () => {
    const src = md('```md', '```sh', 'echo hi', '```', '```', '', '## Next steps', '', 'Ship it.');
    const { html } = render(src);
    expect(html).toContain('<h2>Next steps</h2>');
    expect(html).toContain('<p>Ship it.</p>');
  });
});

// ===========================================================================
// 7. embedded-html-fragments
// ===========================================================================

describe('embedded and broken HTML fragments', () => {
  it('renders markdown inside a container div callout', () => {
    const src = md('<div class="warning">', '**Note:** this endpoint is deprecated and will be removed in v3.', '</div>');
    const { html } = render(src);
    expect(html).toContain('<div class="warning">');
    expect(html).toContain('<strong>Note:</strong>');
  });

  it('preserves the content of a browser-tolerant HTML table with omitted end tags', () => {
    const src = md('<table><tr><td>CPU</td><td>4 vCPU</td></tr>', '<tr><td>RAM<td>16 GB</table>');
    const { html } = render(src);
    expect(html).toContain('4 vCPU');
    expect(html).toContain('16 GB');
    expect(html).toContain('<table>');
  });

  it('still parses a code fence nested inside an unclosed <details> block', () => {
    const src = md(
      '<details><summary>Full stack trace</summary>',
      '',
      '```',
      'java.lang.NullPointerException',
      '    at com.acme.Api.handle(Api.java:52)',
      '```',
      '',
    );
    const { ast } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('java.lang.NullPointerException');
    expect(blocks[0].value).toContain('at com.acme.Api.handle(Api.java:52)');
  });

  it('closes an HTML element left open at EOF instead of leaving the document unbalanced', () => {
    const src = md('<details><summary>Full stack trace</summary>', '', 'Nothing useful here.', '');
    const { html } = render(src);
    expect(html).toContain('<details>');
    expect(html).toContain('</details>');
  });

  it('keeps inline <br> soup working as line breaks', () => {
    const { html } = render('First line<br>Second line<br>Third line');
    expect(count(html, '<br')).toBe(2);
    expect(html).toContain('Third line');
  });

  it('does not markdown-parse the interior of a <pre> element', () => {
    const src = md('<pre>', '**not bold**', '</pre>');
    const { html } = render(src);
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
  });
});

// ===========================================================================
// 8. latex-math-collision
// ===========================================================================

describe('LaTeX math vs emphasis and currency', () => {
  it('keeps subscripts intact instead of parsing underscores as emphasis', () => {
    const src = String.raw`The loss is $L_{total} = L_{ce} + \lambda L_{reg}$ where $\lambda$ controls regularization strength.`;
    const { ast } = parse(src);
    expect(collect(ast, 'inlineMath')).toHaveLength(2);
    const { html } = render(src);
    expect(html).not.toContain('<em>');
    expect(html).toContain('L_{total}');
  });

  it('treats plain dollar amounts as currency, not math', () => {
    const src = 'Prices range from $5 to $10 per seat, billed monthly.';
    const { ast } = parse(src);
    expect(collect(ast, 'inlineMath')).toHaveLength(0);
    const { html } = render(src);
    expect(html).not.toContain('class="math');
    expect(html).toContain('$5 to $10');
  });

  it('recognizes a \\[ ... \\] display math block', () => {
    const src = String.raw`\[
\theta_{t+1} = \theta_t - \eta \nabla_\theta J(\theta)
\]`;
    const { ast } = parse(src);
    const blocks = collect(ast, 'mathBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain(String.raw`\theta_{t+1}`);
  });

  it('auto-closes a $$ display block that was truncated before its closer', () => {
    const src = String.raw`Substituting gives

$$
P(w_t \mid w_{<t}) = \mathrm{softmax}(h_t W^\top)`;
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'mathBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain(String.raw`\mathrm{softmax}`);
    expect(codes(diagnostics)).toContain('math-auto-closed');
  });

  it('stores raw TeX verbatim without applying backslash escape handling', () => {
    const src = String.raw`Then $a \times b$ follows.`;
    const node = collect(parse(src).ast, 'inlineMath')[0];
    expect(node.value).toBe(String.raw`a \times b`);
  });

  it('parses a well-formed $$ block with no repair diagnostics', () => {
    const src = String.raw`Substituting gives

$$
E = mc^2
$$

which is the familiar form.`;
    const { ast, diagnostics } = parse(src);
    expect(collect(ast, 'mathBlock')).toHaveLength(1);
    expect(codes(diagnostics)).not.toContain('math-auto-closed');
  });

  it('does not treat multiplication asterisks as emphasis', () => {
    const { html, diagnostics } = render('For any reals a * b * c the product is associative, and 5 * 3 = 15.');
    expect(html).not.toContain('<em>');
    expect(html).toContain('a * b * c');
    expect(codes(diagnostics)).not.toContain('emphasis-auto-closed');
  });

  it('does not treat intraword underscores in identifiers as emphasis', () => {
    const { html } = render('The flag is called max_retry_count and lives in retry_policy_config.');
    expect(html).not.toContain('<em>');
    expect(html).toContain('max_retry_count');
  });
});

// ===========================================================================
// 9. hr-setext-frontmatter-ambiguity
// ===========================================================================

describe('dash lines: setext headings, rules, and front matter', () => {
  it('reads attached dash lines as setext headings and an isolated one as a rule', () => {
    const src = md(
      'Key Findings',
      '---',
      'Revenue grew 14% QoQ, driven by the enterprise tier.',
      '',
      '---',
      '',
      'Risks',
      '---',
      'Churn in SMB is up 2pts.',
    );
    const { html } = render(src);
    expect(html).toContain('<h2>Key Findings</h2>');
    expect(html).toContain('<h2>Risks</h2>');
    expect(count(html, '<hr />')).toBe(1);
  });

  it('recognizes YAML front matter at the top of the document', () => {
    const src = md('---', 'title: Weekly Ops Report', 'author: statusbot', 'date: 2026-08-07', '---', '', '# Summary');
    const { ast, html } = { ...parse(src), html: render(src).html };
    const fm = collect(ast, 'frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].value).toContain('title: Weekly Ops Report');
    expect(fm[0].value).toContain('date: 2026-08-07');
    expect(html).toContain('<h1>Summary</h1>');
    expect(html).not.toContain('<hr />');
    expect(html).not.toContain('<h2>');
  });

  it('keeps a full sentence as a paragraph and the dashes below it as a rule', () => {
    const src = md('The rollout completed without incident.', '---', 'Next week we begin the EU migration.');
    const { html, diagnostics } = render(src);
    expect(html).toContain('<p>The rollout completed without incident.</p>');
    expect(html).toContain('<hr />');
    expect(html).not.toContain('<h2>');
    expect(codes(diagnostics)).toContain('setext-vs-break-ambiguity');
  });

  it('biases toward rules in a document whose heading style is clearly ATX', () => {
    const src = md(
      '# Report',
      '',
      'Intro line.',
      '',
      '---',
      '',
      '## Section A',
      '',
      'Body A ends here',
      '---',
      '',
      '## Section B',
      '',
      'Body B',
      '',
      '---',
      '',
      '## Section C',
    );
    const { html } = render(src);
    expect(html).toContain('<h2>Section A</h2>');
    expect(html).not.toContain('<h2>Body A ends here</h2>');
  });

  it('collapses a run of consecutive separators into a single rule', () => {
    const { html } = render(md('Alpha paragraph.', '', '---', '', '---', '', '---', '', 'Beta paragraph.'));
    expect(count(html, '<hr />')).toBe(1);
    expect(html).toContain('<p>Beta paragraph.</p>');
  });

  it('leaves a well-formed === setext heading alone', () => {
    const { html, diagnostics } = render(md('Project Overview', '================', '', 'Body text.'));
    expect(html).toContain('<h1>Project Overview</h1>');
    expect(diagnostics).toHaveLength(0);
  });

  it('does not treat a mid-document --- fence-like line as front matter', () => {
    const src = md('# Title', '', 'Body.', '', '---', '', 'title: not front matter', '', '---');
    const { ast } = parse(src);
    expect(collect(ast, 'frontmatter')).toHaveLength(0);
  });
});

// ===========================================================================
// 10. retry-interleave-duplication
// ===========================================================================

describe('retry duplication and self-correction', () => {
  const correctedTable = md(
    '## Configuration',
    '',
    '| Key | Default |',
    '|-----|---------|',
    '| timeout | 30s |',
    '',
    "Wait — I should include the description column. Here's the corrected table:",
    '',
    '| Key | Default | Description |',
    '|-----|---------|-------------|',
    '| timeout | 30s | Request timeout before retry |',
  );

  it('keeps the corrected table intact', () => {
    const { html } = render(correctedTable);
    expect(html).toContain('<th>Description</th>');
    expect(html).toContain('<td>Request timeout before retry</td>');
  });

  // DECLINED: Kintsugi never deletes content. A retry that duplicates a table
  // keeps both copies; deciding which one the author meant to keep is the
  // reader's call, not the parser's. See README non-goals.
  it.skip('drops the superseded table when an explicit correction cue precedes the replacement', () => {
    const { ast } = parse(correctedTable);
    const tables = collect(ast, 'table').filter((t: any) => t.superseded !== true);
    expect(tables).toHaveLength(1);
    expect(textOf(tables[0])).toContain('Request timeout before retry');
  });

  // DECLINED: same reason — de-duplicating near-identical prose risks deleting
  // content that was genuinely repeated.
  it.skip('renders only one copy of a near-duplicate opening re-emitted by a stream retry', () => {
    const src = md(
      '# Deployment Guide',
      '',
      'This guide covers the blue/green rollout for the payments service.',
      '',
      '# Deployment Guide',
      '',
      'This guide covers the blue/green rollout process for the payments service.',
      '',
      '## Prerequisites',
    );
    const { html } = render(src);
    expect(count(html, '<h1>Deployment Guide</h1>')).toBe(1);
    expect(html).toContain('<h2>Prerequisites</h2>');
  });

  it('does not deduplicate legitimately repeated list items', () => {
    const { html } = render(md('Retry policy:', '', '- retry', '- retry', '- retry'));
    expect(count(html, '<li>retry</li>')).toBe(3);
  });

  it('does not deduplicate identical headings that belong to different sections', () => {
    const src = md(
      '## GET /orders',
      '',
      'Returns a page of orders.',
      '',
      '### Request',
      '',
      'No body.',
      '',
      '## POST /orders',
      '',
      'Creates an order.',
      '',
      '### Request',
      '',
      'A JSON body with line items.',
    );
    const { html } = render(src);
    expect(count(html, '<h3>Request</h3>')).toBe(2);
  });
});

// ===========================================================================
// 11. invisible-character-corruption
// ===========================================================================

describe('invisible characters at load-bearing positions', () => {
  it('parses a heading whose hash is preceded by a byte-order mark', () => {
    const src = BOM + md('# Release Notes 1.8', '', '- Fixed pagination on /orders');
    const { html, diagnostics } = render(src);
    expect(html).toContain('<h1>Release Notes 1.8</h1>');
    expect(html).toContain('<li>Fixed pagination on /orders</li>');
    expect(codes(diagnostics)).toContain('doc-stripped-bom');
  });

  it('treats non-breaking spaces used as list indentation as real indentation', () => {
    const src = md('- deploy steps', NBSP + NBSP + '- run migrations', NBSP + NBSP + '- restart workers');
    const { ast, html } = { ...parse(src), html: render(src).html };
    const lists = collect(ast, 'list');
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(maxNesting(ast, 'list')).toBeGreaterThanOrEqual(2);
    expect(html).toContain('run migrations');
  });

  it('matches emphasis across a zero-width space next to the closing delimiter', () => {
    const { html } = render(`**Critical${ZWSP}** paths must be reviewed before merge.`);
    expect(html).toContain('<strong>Critical</strong>');
    expect(html).not.toContain('**');
  });

  it('parses a CRLF table whose delimiter row carries stray carriage returns', () => {
    const src = '| Check | Owner |\r\n|-------|-------|\r\n| Lint  | CI    |\r\n';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<th>Check</th>');
    expect(html).toContain('<td>Lint</td>');
    expect(codes(diagnostics)).toContain('doc-normalized-line-endings');
  });

  it('closes a CRLF code fence instead of reporting it unclosed', () => {
    const src = '```js\r\nconst a = 1;\r\n```\r\n\r\nAfter the fence.\r\n';
    const { ast, diagnostics } = parse(src);
    const blocks = collect(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].autoClosed).toBe(false);
    expect(codes(diagnostics)).not.toContain('fence-unclosed');
    expect(collect(ast, 'paragraph')).toHaveLength(1);
  });

  it('preserves a non-breaking space used as intentional typography inside prose', () => {
    const src = `The limit is 10${NBSP}km per request.`;
    const { html } = render(src);
    expect(html).toContain(`10${NBSP}km`);
  });

  it('preserves zero-width joiners inside words where they are meaningful', () => {
    const src = `Persian word: می‌رود in the glossary.`;
    const { html } = render(src);
    expect(html).toContain('‌');
  });
});

// ===========================================================================
// 12. delimiter-flood-performance
// ===========================================================================

describe('pathological repetition and performance guarantees', () => {
  it('contains a 40k-bracket repetition loop without hanging', () => {
    const src = 'See also ' + '['.repeat(40000);
    const t0 = Date.now();
    const { ast } = parse(src);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ast.type).toBe('document');
    expect(ast.children.length).toBeGreaterThan(0);
  }, 20000);

  it('handles a 200KB flood of unmatched emphasis openers in near-linear time', () => {
    const src = '*important *note *see *below *for *details *and *more '.repeat(4000);
    const t0 = Date.now();
    const { ast } = parse(src);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ast.type).toBe('document');
  }, 20000);

  it('caps runaway blockquote nesting instead of recursing without bound', () => {
    const line = '> '.repeat(600) + 'quoted line';
    const src = Array.from({ length: 500 }, () => line).join('\n');
    const t0 = Date.now();
    const { ast } = parse(src);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(maxNesting(ast, 'blockquote')).toBeLessThanOrEqual(64);
  }, 30000);

  it('bounds the column count of a table row containing thousands of pipes', () => {
    const src = md('| a | b |', '|---|---|', '|' + ' x |'.repeat(5000));
    const t0 = Date.now();
    const { ast } = parse(src);
    expect(Date.now() - t0).toBeLessThan(5000);
    const rows = collect(ast, 'tableRow');
    for (const row of rows) expect(row.cells.length).toBeLessThanOrEqual(512);
  }, 20000);

  it('renders a flooded document without producing megabytes of markup', () => {
    const src = 'See also ' + '['.repeat(40000);
    const { html } = render(src);
    expect(typeof html).toBe('string');
    expect(html.length).toBeLessThan(200000);
  }, 20000);

  it('does not apply delimiter caps to an ordinary document with many emphasis spans', () => {
    const words = Array.from({ length: 100 }, (_, i) => `*word${i}*`).join(' ');
    const { html } = render(words);
    expect(count(html, '<em>')).toBe(100);
    expect(html).toContain('<em>word99</em>');
  });
});

// ===========================================================================
// 13. non-commonmark-extension-syntax
// ===========================================================================

describe('extension syntax LLMs emit that CommonMark lacks', () => {
  it('links a footnote reference to its definition rather than showing literal brackets', () => {
    const src = md('The improvement was statistically significant[^1].', '', '[^1]: p < 0.05, two-tailed t-test, n = 1,240.');
    const { html } = render(src);
    expect(html).not.toContain('[^1]');
    expect(html).toContain('two-tailed t-test');
  });

  it('renders a Pandoc-style definition list as terms and definitions', () => {
    const src = md(
      'Throughput',
      ': Requests served per second at p50 latency.',
      '',
      'Latency',
      ': Time from request receipt to first response byte.',
    );
    const { html } = render(src);
    expect(html).toContain('<dt>Throughput</dt>');
    expect(html).toContain('<dd>Requests served per second at p50 latency.</dd>');
  });

  it('recognizes a GitHub alert instead of rendering [!WARNING] literally', () => {
    const src = md('> [!WARNING]', '> This migration drops the legacy_orders table and cannot be rolled back.');
    const { html } = render(src);
    expect(html).not.toContain('[!WARNING]');
    expect(html).toContain('cannot be rolled back');
  });

  it('auto-closes an unterminated ::: admonition container', () => {
    const src = md(':::note', 'Rotate the signing keys after every incident.', '', 'See the runbook for the full procedure.');
    const { html } = render(src);
    expect(html).not.toContain(':::note');
    expect(html).toContain('Rotate the signing keys after every incident.');
    expect(html).toContain('See the runbook for the full procedure.');
  });

  it('renders ==highlight== as a mark', () => {
    const { html } = render('The ==critical== path must stay under 200ms.');
    expect(html).toContain('<mark>critical</mark>');
  });

  it('keeps a [!WARNING]-looking line literal when it is not the first line of the quote', () => {
    const src = md('> The alert syntax is written like this:', '> [!WARNING]', '> and it must be the first line.');
    const { html } = render(src);
    expect(html).toContain('[!WARNING]');
  });

  it('renders GFM strikethrough without any repair', () => {
    const { html, diagnostics } = render('The ~~legacy~~ v2 endpoint is preferred.');
    expect(html).toContain('<del>legacy</del>');
    expect(diagnostics).toHaveLength(0);
  });

  it('renders GFM task lists with checkbox state', () => {
    const { html, diagnostics } = render(md('- [x] migrate schema', '- [ ] backfill rows'));
    expect(html).toContain('checked');
    expect(html).toContain('migrate schema');
    expect(html).toContain('backfill rows');
    expect(diagnostics).toHaveLength(0);
  });

  it('renders an autolink without repair', () => {
    const { html, diagnostics } = render('Docs live at <https://example.com/docs>.');
    expect(html).toContain('href="https://example.com/docs"');
    expect(diagnostics).toHaveLength(0);
  });
});

// ===========================================================================
// never-fail contract across every taxonomy example
// ===========================================================================

const TAXONOMY_INPUTS: [string, string][] = [
  ['truncated fence', '## Deployment\n\nRun the migration job first:\n\n```bash\nkubectl apply -f migrations/\nkubectl rollout status deploy/api --time'],
  ['truncated table', '| Region    | Instances | Monthly cost |\n|-----------|-----------|--------------|\n| us-east-1 | 12        | $4,320       |\n| eu-west-1 | 8         | $2,9'],
  ['truncated bold', 'The single most important property is **idempotency: retries must not'],
  ['truncated link', '3. Configure the webhook endpoint ([see docs](https://api.example.com/v2/web'],
  ['wrapped document', '```markdown\n# Q3 Incident Report\n\n## Summary\nOn 2026-07-14 the payments API returned elevated 5xx for 41 minutes.\n\n## Timeline\n- 14:02 UTC: alerts fire\n- 14:09 UTC: rollback initiated\n```'],
  ['wrapped compose file', '```\nservices:\n  api:\n    image: acme/api:1.4\n    ports:\n      - "8080:8080"\n```'],
  ['wrapped + truncated + inner fence', '```markdown\n# Migration Guide\n\n## Step 1\nBack up the database:\n\n```sh\npg_dump prod > backup.sql\n```'],
  ['inline syntax mention', 'A common mistake is writing #Heading without a space after the hash. Change #Heading to # Heading and it will render.'],
  ['deliberately broken table', 'If you forget the delimiter row, the table will not render:\n\n| Name | Role |\n| Ada | Engineer |\n\nAdd a `|------|------|` line after the header to fix it.'],
  ['fence inside fence tutorial', 'Here\'s how to show a code block in your README:\n\n```\n```python\nprint("hi")\n```\n```\n\nCommit that and you\'re done.'],
  ['chat frame around yaml', 'Sure! Here\'s the complete `docker-compose.yml` with the healthcheck added:\n\n```yaml\nservices:\n  api:\n    image: acme/api:1.4\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]\n```\n\nLet me know if you\'d also like a staging profile!'],
  ['leaked thinking tags', '<thinking>\nThe user wants the summary as a table, so I should include columns for owner and ETA.\n</thinking>\n\n# Sprint Summary\n\n| Task | Owner | ETA |\n|------|-------|-----|\n| Auth refactor | Dana | Fri |'],
  ['trailing control tokens', '# Weekly Report\n\nAll deploys green; error budget at 94%.\n</output><|im_end|>'],
  ['yaml mislabeled json', '```json\nname: deploy\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n```'],
  ['triple apostrophe fence', "'''python\nimport os\nprint(os.environ[\"HOME\"])\n'''"],
  ['language on first line', '```\npython\nfor i in range(3):\n    print(i)\n```'],
  ['nested md/sh fences', 'Add this section to your README:\n\n```md\n## Install\n\n```sh\nnpm i @acme/toolkit\n```\n```\n\nThen commit the change.'],
  ['bare nested template fence', '```\nHere is the template:\n```\nYou are a helpful assistant.\nRespond in JSON.\n```\n```'],
  ['markdown in div', '<div class="warning">\n**Note:** this endpoint is deprecated and will be removed in v3.\n</div>'],
  ['broken html table', '<table><tr><td>CPU</td><td>4 vCPU</td></tr>\n<tr><td>RAM<td>16 GB</table>'],
  ['unclosed details', '<details><summary>Full stack trace</summary>\n\n```\njava.lang.NullPointerException\n    at com.acme.Api.handle(Api.java:52)\n```\n'],
  ['inline math with subscripts', String.raw`The loss is $L_{total} = L_{ce} + \lambda L_{reg}$ where $\lambda$ controls regularization strength.`],
  ['currency dollars', 'Prices range from $5 to $10 per seat, billed monthly.'],
  ['bracket display math', String.raw`\[
\theta_{t+1} = \theta_t - \eta \nabla_\theta J(\theta)
\]`],
  ['truncated display math', String.raw`Substituting gives

$$
P(w_t \mid w_{<t}) = \mathrm{softmax}(h_t W^\top)`],
  ['setext and rule mix', 'Key Findings\n---\nRevenue grew 14% QoQ, driven by the enterprise tier.\n\n---\n\nRisks\n---\nChurn in SMB is up 2pts.'],
  ['front matter', '---\ntitle: Weekly Ops Report\nauthor: statusbot\ndate: 2026-08-07\n---\n\n# Summary'],
  ['sentence above dashes', 'The rollout completed without incident.\n---\nNext week we begin the EU migration.'],
  ['self-corrected table', "## Configuration\n\n| Key | Default |\n|-----|---------|\n| timeout | 30s |\n\nWait — I should include the description column. Here's the corrected table:\n\n| Key | Default | Description |\n|-----|---------|-------------|\n| timeout | 30s | Request timeout before retry |"],
  ['duplicated opening', '# Deployment Guide\n\nThis guide covers the blue/green rollout for the payments service.\n\n# Deployment Guide\n\nThis guide covers the blue/green rollout process for the payments service.\n\n## Prerequisites'],
  ['bom before heading', BOM + '# Release Notes 1.8\n\n- Fixed pagination on /orders'],
  ['nbsp indentation', `- deploy steps\n${NBSP}${NBSP}- run migrations\n${NBSP}${NBSP}- restart workers`],
  ['zwsp and crlf', `**Critical${ZWSP}** paths must be reviewed before merge.\r\n| Check | Owner |\r\n|-------|-------|\r\n| Lint  | CI    |`],
  ['bracket flood', 'See also ' + '['.repeat(40000)],
  ['emphasis flood', '*important *note *see *below *for *details *and *more '.repeat(2000)],
  ['deep blockquotes', (('> '.repeat(600) + 'quoted line\n').repeat(200))],
  ['footnote', 'The improvement was statistically significant[^1].\n\n[^1]: p < 0.05, two-tailed t-test, n = 1,240.'],
  ['definition list', 'Throughput\n: Requests served per second at p50 latency.\n\nLatency\n: Time from request receipt to first response byte.'],
  ['github alert', '> [!WARNING]\n> This migration drops the legacy_orders table and cannot be rolled back.'],
  ['unclosed admonition', ':::note\nRotate the signing keys after every incident.\n\nSee the runbook for the full procedure.'],
  ['empty document', ''],
  ['whitespace only', '   \n\n\t\n'],
];

describe('never-fail contract', () => {
  it.each(TAXONOMY_INPUTS)('returns a document without throwing for: %s', (_name, src) => {
    expect(() => parse(src)).not.toThrow();
    const { ast, diagnostics } = parse(src);
    expect(ast.type).toBe('document');
    expect(Array.isArray(ast.children)).toBe(true);
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(() => render(src)).not.toThrow();
    expect(typeof render(src).html).toBe('string');
  }, 30000);

  it('never reports an internal-error fallback for any taxonomy input', () => {
    for (const [name, src] of TAXONOMY_INPUTS) {
      const { diagnostics } = parse(src);
      const internal = diagnostics.filter((d) => d.message.includes('Internal parser error'));
      expect(internal, `internal error on: ${name}`).toEqual([]);
    }
  }, 60000);
});
