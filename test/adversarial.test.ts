import { describe, expect, it } from 'vitest';
import { parse, render } from '../src/index.js';

/**
 * Regressions found by adversarial review — agents whose only job was to break
 * the parser, with every finding independently reproduced before it was fixed.
 *
 * These are the cases the fixture suite missed, so they are the ones most worth
 * guarding: unbounded recursion, content deleted without a diagnostic, valid
 * markdown "repaired", and hot paths that were quadratic.
 */

const repairs = (src: string) => parse(src).diagnostics.filter((d) => d.severity === 'repair');
const internalError = (src: string) =>
  parse(src).diagnostics.some((d) => /Internal parser error/.test(d.message));

describe('adversarial: unbounded recursion', () => {
  it('renders deeply nested inline HTML without blowing the stack', () => {
    const src = '<b>'.repeat(8000) + 'x' + '</b>'.repeat(8000);
    expect(() => render(src)).not.toThrow();
    expect(render(src).html).toContain('x');
  });

  it('survives deep nesting inside an image alt', () => {
    const src = '![' + '<b>'.repeat(10000) + 'x' + '</b>'.repeat(10000) + '](u.png)';
    expect(() => render(src)).not.toThrow();
  });

  it('parses one long over-indented prose line as a paragraph', () => {
    const src = ' '.repeat(10000) + 'This is a sentence of prose that reads like prose.';
    expect(internalError(src)).toBe(false);
    expect(render(src).html).toContain('reads like prose');
  });

  it('survives the tab-indented form of the same line', () => {
    const src = '\t'.repeat(2000) + 'This is a sentence of prose that reads like prose.';
    expect(internalError(src)).toBe(false);
  });

  it('does not lose surrounding markdown to an over-indented line', () => {
    const src = ['# Quarterly Report', '', ' '.repeat(9000) + 'An indented aside sentence here.', '', '- one', '- two'].join('\n');
    const { html } = render(src);
    expect(internalError(src)).toBe(false);
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<li>one</li>');
  });

  it('survives deeply nested HTML containers', () => {
    const src = '<div>\n'.repeat(2000) + '**x**\n' + '</div>\n'.repeat(2000);
    expect(internalError(src)).toBe(false);
  });

  it('survives a long run of unclosed ::: containers', () => {
    const src = ':::note\n'.repeat(2500) + 'x\n';
    expect(internalError(src)).toBe(false);
  });

  it('survives a block of ASCII box borders', () => {
    const src = '+---+---+\n'.repeat(4000);
    expect(internalError(src)).toBe(false);
    expect(parse(src).diagnostics.length).toBeLessThan(50);
  });
});

describe('adversarial: content is never dropped', () => {
  it('keeps a table cell that documents the literal escape sequence', () => {
    const { html } = render('| Escape | Meaning |\n| --- | --- |\n| \\n | Newline |\n| \\t | Tab |');
    expect(html).toContain('\\n');
    expect(html).toContain('\\t');
  });

  it('keeps a trailing ** footnote marker in a cell instead of bolding the value', () => {
    const { html } = render('| Metric | Value |\n| --- | --- |\n| Uptime | 99.9%** |\n\n** measured over 30 days');
    expect(html).toContain('99.9%**');
    expect(html).not.toContain('<strong>99.9%</strong>');
  });

  it('still closes bold that genuinely opened in an earlier cell', () => {
    const { html } = render('| Metric | **Baseline | Improved** |\n|---|---|---|\n| p50 | 240ms | 180ms |');
    expect(html).toContain('<strong>Baseline</strong>');
    expect(html).toContain('<strong>Improved</strong>');
  });

  it('keeps a footnote definition that was never referenced', () => {
    const src = '# Title\n\nBody text.\n\n[^note]: Numbers exclude the EMEA region.\n';
    expect(JSON.stringify(parse(src).ast)).toContain('EMEA');
    expect(render(src).html).toContain('EMEA');
  });

  it('keeps both bodies when a footnote is defined twice', () => {
    const src = 'Claim[^1].\n\n[^1]: First definition.\n\n[^1]: Corrected definition.\n';
    const { html, diagnostics } = render(src);
    expect(html).toContain('First definition');
    expect(html).toContain('Corrected definition');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('reports a footnote reference that has no definition', () => {
    const { diagnostics } = parse('Revenue rose 12%[^src] last quarter.');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('keeps a caption sentence under a table out of the last cell', () => {
    const { html } = render('| Metric | Value |\n| --- | --- |\n| Errors | 3 |\nall figures are averages over the last 30 days.');
    expect(html).toContain('<td>3</td>');
    expect(html).toContain('all figures are averages');
  });
});

describe('adversarial: valid markdown is left alone', () => {
  it('does not join two currency amounts in one row', () => {
    const { html } = render('| Plan | Monthly | Annual |\n| --- | --- | --- |\n| Pro | $10 | $100 |');
    expect(html).toContain('<td>$10</td>');
    expect(html).toContain('<td>$100</td>');
  });

  it('keeps a canonical nested ordered list nested', () => {
    const src = '1. Installation\n   1. Download the archive\n   2. Extract it\n   3. Run the installer\n2. Verification';
    const { html } = render(src);
    const outer = parse(src).ast.children.find((c) => c.type === 'list');
    expect(outer && outer.type === 'list' && outer.children).toHaveLength(2);
    expect(html).toContain('Run the installer');
    expect(repairs(src)).toEqual([]);
  });

  it('reports no repair for a consistently 4-space-nested list', () => {
    expect(repairs('- Item one\n    - Nested a\n    - Nested b\n- Item two')).toEqual([]);
  });

  it('leaves a standalone bold sentence as emphasis, not a heading', () => {
    const src = 'The deploy runs at 09:00 UTC.\n\n**Never deploy on a Friday**\n\nRollbacks take about ten minutes.';
    const { html } = render(src);
    expect(html).toContain('<strong>Never deploy on a Friday</strong>');
    expect(html).not.toMatch(/<h[1-6]>Never deploy/);
    expect(repairs(src)).toEqual([]);
  });

  it('still promotes a label-like bold line to a heading', () => {
    expect(render('**Section 2: Results**\n\nAccuracy improved.').html).toMatch(/<h[1-6]>Section 2: Results<\/h[1-6]>/);
    expect(render('**Step 3 — Deploy the service:**\n\nRun it.').html).toMatch(/<h[1-6]>Step 3/);
  });
});

describe('adversarial: recovery still fires where it should', () => {
  it('unwraps a markdown wrapper that generation never closed', () => {
    const { html } = render('```markdown\n# Quarterly Report\n\n## Revenue\n\nRevenue grew 12%.\n\n## Costs\n\nCosts fell 3');
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<h2>Revenue</h2>');
  });

  it('leaves a truncated ```python block as code', () => {
    const { html } = render('```python\ndef f():\n    return 1');
    expect(html).toContain('<code class="language-python">');
  });
});

describe('adversarial: hot paths stay linear', () => {
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
    // Valid markdown, zero diagnostics — this was 22 seconds at 375 KB.
    ['plain bold spans', (n) => '**a** '.repeat(n)],
    ['dollar amounts on one line', (n) => 'costs $5 or $10 and '.repeat(n)],
    ['distinct footnote refs', (n) => Array.from({ length: n }, (_, i) => `p${i} ref[^f${i}] end.`).join('\n\n')],
    ['apostrophe fence lines', (n) => "'''x\n\n".repeat(n)],
    ['leaked scaffolding openers', (n) => '<thinking>\n\n'.repeat(n)],
  ];

  for (const [name, gen] of cases) {
    it(`stays near-linear on ${name}`, () => {
      timeIt(gen(2000));
      const small = Math.max(timeIt(gen(4000)), 0.5);
      const large = timeIt(gen(16000));
      expect(large / small).toBeLessThan(8);
    });
  }
});
