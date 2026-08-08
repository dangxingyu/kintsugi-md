import { describe, expect, it } from 'vitest';
import { parse, render } from '../src/index.js';

/**
 * The parser's two load-bearing promises:
 *   1. parse() never throws and always returns a document, for ANY input.
 *   2. well-formed markdown is left alone — no repairs, standard reading.
 */

describe('contract: never throws', () => {
  const inputs: Array<[string, string]> = [
    ['empty string', ''],
    ['only whitespace', '   \n\t\n   '],
    ['only newlines', '\n'.repeat(50)],
    ['lone backslash', '\\'],
    ['lone asterisk', '*'],
    ['lone pipe', '|'],
    ['lone bracket', '['],
    ['lone backtick', '`'],
    ['lone dollar', '$'],
    ['lone angle', '<'],
    ['unterminated fence', '```'],
    ['unterminated fence with lang', '```python'],
    ['unterminated frontmatter', '---\ntitle: x'],
    ['unterminated math', '$$'],
    ['unterminated latex', '\\['],
    ['unterminated html comment', '<!--'],
    ['null bytes', 'a\0b'],
    ['lone surrogate', 'a\ud800b'],
    ['bom only', '﻿'],
    ['crlf only', '\r\n\r\n'],
    ['deep nesting', '> '.repeat(200) + 'x'],
    ['all delimiters', '*_~`[]()<>|#-+!$\\'],
    ['emoji and rtl', '🎉 مرحبا שלום 你好'],
    ['zero width flood', '​'.repeat(500) + 'text'],
    ['tab indentation', '\t\t\tcode?'],
    ['table fragment', '|||'],
    ['separator only', '|---|'],
    ['many hashes', '#'.repeat(50) + ' heading'],
    ['digits and dots', '1.'.repeat(200)],
  ];

  for (const [name, src] of inputs) {
    it(`survives ${name}`, () => {
      expect(() => parse(src)).not.toThrow();
      const { ast, diagnostics } = parse(src);
      expect(ast.type).toBe('document');
      expect(Array.isArray(ast.children)).toBe(true);
      expect(Array.isArray(diagnostics)).toBe(true);
    });
  }

  it('survives randomized delimiter soup', () => {
    const alphabet = ['*', '_', '`', '[', ']', '(', ')', '|', '#', '-', '>', '\n', ' ', '~', '$', '\\', '<', '>', 'a', '1', '.', ':'];
    // Deterministic PRNG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 400; trial++) {
      let s = '';
      const len = 20 + Math.floor(rnd() * 400);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(() => parse(s), `failed on: ${JSON.stringify(s)}`).not.toThrow();
    }
  });

  it('renders any parseable document without throwing', () => {
    for (const [, src] of inputs) {
      expect(() => render(src)).not.toThrow();
    }
  });
});

describe('contract: well-formed markdown is not "repaired"', () => {
  const clean: Array<[string, string]> = [
    ['heading', '# Title\n\nA paragraph.'],
    ['all heading levels', '# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f'],
    ['bullet list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two\n3. three'],
    ['nested list', '- one\n  - nested\n- two'],
    ['proper table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['aligned table', '| a | b |\n| :-- | --: |\n| 1 | 2 |'],
    ['closed fence', '```js\nconst x = 1;\n```'],
    ['tilde fence', '~~~\nplain\n~~~'],
    ['emphasis', 'This is *em* and **strong** and `code`.'],
    ['link', 'See [docs](https://example.com).'],
    ['image', '![alt](https://example.com/a.png)'],
    ['blockquote', '> quoted text\n> more quoted'],
    ['thematic break', 'before\n\n---\n\nafter'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['reference link', 'See [docs][d].\n\n[d]: https://example.com'],
    ['strikethrough', 'This is ~~gone~~.'],
    ['hard break', 'line one  \nline two'],
    ['inline html', 'Press <kbd>Esc</kbd> now.'],
    ['autolink', 'Visit <https://example.com> today.'],
    ['setext h1', 'Title\n=====\n\nBody text.'],
    ['escaped chars', 'A literal \\*asterisk\\* and \\_underscore\\_.'],
    ['frontmatter', '---\ntitle: Test\n---\n\n# Body'],
  ];

  for (const [name, src] of clean) {
    it(`leaves ${name} alone`, () => {
      const { diagnostics } = parse(src);
      const repairs = diagnostics.filter((d) => d.severity === 'repair');
      expect(repairs, `unexpected repairs: ${JSON.stringify(repairs)}`).toEqual([]);
    });
  }

  it('produces standard HTML for a well-formed document', () => {
    const { html } = render('# Title\n\nA *paragraph* with `code`.\n\n- one\n- two');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>paragraph</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });
});

describe('contract: repairs are reported, not silent', () => {
  it('reports every repair it makes with a source line', () => {
    const { diagnostics } = parse('##Heading\n\n| a | b |\n| 1 | 2 |\n\n```js\nunclosed');
    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
    for (const d of diagnostics) {
      expect(d.line).toBeGreaterThanOrEqual(1);
      expect(d.message).toBeTruthy();
      expect(['repair', 'note']).toContain(d.severity);
    }
  });

  it('reports diagnostic lines that map to the original source', () => {
    const src = 'line one\n\nline three\n\n##Heading on line five';
    const { diagnostics } = parse(src);
    const heading = diagnostics.find((d) => d.code === 'heading-missing-space');
    expect(heading?.line).toBe(5);
  });

  it('keeps original line numbers after unwrapping a document fence', () => {
    const src = ['```markdown', '# Title', '', '- a', '- b', '```'].join('\n');
    const { ast } = parse(src);
    const heading = ast.children.find((c) => c.type === 'heading');
    expect(heading?.pos.startLine).toBe(2);
  });
});

describe('contract: setext-vs-rule judgement', () => {
  const doc = (middle: string) =>
    ['# Report', '', '## Executive Summary', '', 'Some prose here.', '', middle, '', 'More prose.'].join('\n');

  it('reads a title-cased line over dashes as a heading, even in an ATX document', () => {
    const { html } = render(doc('Benchmark Results\n---'));
    expect(html).toContain('<h2>Benchmark Results</h2>');
    expect(html).not.toContain('<p>Benchmark Results</p>');
  });

  it('reads a sentence over dashes as a rule, not a heading', () => {
    const { html } = render(doc('Body A ends here\n---'));
    expect(html).toContain('<hr />');
    expect(html).not.toMatch(/<h[12]>Body A ends here/);
  });

  it('reads an ALL CAPS line over dashes as a heading', () => {
    const { html } = render(doc('SYSTEM REQUIREMENTS\n---'));
    expect(html).toContain('<h2>SYSTEM REQUIREMENTS</h2>');
  });

  it('reads dashes after a full sentence as a rule', () => {
    const { html } = render(doc('This section is now complete.\n---'));
    expect(html).toContain('<hr />');
  });
});

describe('contract: security', () => {
  it('escapes HTML in text content', () => {
    const { html } = render('A <script>alert(1)</script> tag in prose.');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('neutralizes javascript: URLs in links', () => {
    const { html } = render('[click](javascript:alert(1))');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('neutralizes obfuscated javascript: URLs', () => {
    const { html } = render('[click](java\tscript:alert(1))');
    expect(html).not.toMatch(/href="java\s*script:/i);
  });

  it('neutralizes non-image data: URLs', () => {
    const { html } = render('[click](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toMatch(/href="data:text\/html/i);
  });

  it('allows ordinary links through untouched', () => {
    const { html } = render('[ok](https://example.com/a?b=1&c=2)');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
  });

  it('escapes raw HTML blocks when allowHtml is false', () => {
    const { html } = render('<div onclick="steal()">x</div>', { allowHtml: false });
    expect(html).not.toContain('<div onclick');
  });
});

describe('contract: performance is linear', () => {
  /**
   * Best-of-N wall clock. The suite runs files in parallel, so a single
   * measurement picks up scheduling noise; the minimum is the closest thing to
   * uncontended time and keeps this test from flaking.
   */
  const timeIt = (src: string, runs = 3): number => {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      parse(src);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  const cases: Array<[string, (n: number) => string]> = [
    ['unclosed links', (n) => '[a](b'.repeat(n)],
    ['nested brackets', (n) => '['.repeat(n) + 'x' + ']'.repeat(n)],
    ['images', (n) => '![a](b'.repeat(n)],
    ['brackets then links', (n) => '[a](b'.repeat(n) + '['.repeat(n)],
    ['emphasis flood', (n) => '*a**b*'.repeat(n)],
    ['unclosed bold', (n) => '**x '.repeat(n)],
    ['pipe flood', (n) => '|a'.repeat(n)],
    ['backtick flood', (n) => '`'.repeat(n)],
    ['padded bold', (n) => '** x ** '.repeat(n)],
    ['inline html spans', (n) => '<b>x</b> '.repeat(n)],
    ['strikethrough', (n) => '~~x '.repeat(n)],
    ['inline math', (n) => '$x$ '.repeat(n)],
    ['footnote refs', (n) => 'x[^1] '.repeat(n) + '\n\n[^1]: note'],
    ['reference links', (n) => '[a][b]'.repeat(n) + '\n\n[b]: https://example.com'],
    ['one long line of links', (n) => '[text](https://example.com/a) '.repeat(n)],
  ];

  for (const [name, gen] of cases) {
    it(`stays near-linear on ${name}`, () => {
      // Warm up so JIT compilation doesn't inflate the small case.
      timeIt(gen(2000));
      const small = Math.max(timeIt(gen(4000)), 0.5);
      const large = timeIt(gen(16000));
      // 4x the input should cost roughly 4x the time. Quadratic would be ~16x.
      // The bound leaves room for a noisy machine while still failing loudly on
      // an accidental O(n^2) scan — the failure mode that keeps coming back.
      expect(large / small).toBeLessThan(8);
    });
  }

  it('parses a large realistic document quickly', () => {
    const section = [
      '## Section',
      '',
      'Some prose with **bold**, `code`, and a [link](https://example.com).',
      '',
      '| a | b | c |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
      '',
      '- item one',
      '- item two',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
    ].join('\n');
    const doc = section.repeat(500); // ~ 500 sections
    const ms = timeIt(doc);
    expect(ms).toBeLessThan(3000);
  });
});
