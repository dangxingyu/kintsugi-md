import { describe, expect, it } from 'vitest';
import { parse, render } from '../src/index.js';

/**
 * Regressions for the four clusters that a false-positive audit of 3,090 real
 * READMEs exposed. Each cluster was a repair that fired constantly and was
 * almost always wrong; each fix is guarded here in both directions — the false
 * positive must stop, and the genuine repair it was hiding must still work.
 */

const repairs = (src: string) => parse(src).diagnostics.filter((d) => d.severity === 'repair');
const codes = (src: string) => parse(src).diagnostics.map((d) => d.code);
const count = (h: string, tag: string) => (h.match(new RegExp(tag, 'g')) ?? []).length;

describe('cluster 1: HTML blocks split across blank lines are not force-closed', () => {
  it('leaves a <details> with a blank line before its body intact', () => {
    const src = '<details>\n<summary>Click me</summary>\n\nHidden content.\n\n</details>\n\nAfter.';
    const { html } = render(src);
    // Exactly one closer — the author's own — not two.
    expect(count(html, '</details>')).toBe(1);
    // Content stays inside: the closer comes after the content, not before it.
    expect(html.indexOf('Hidden content')).toBeLessThan(html.indexOf('</details>'));
    expect(repairs(src)).toEqual([]);
  });

  it('does not empty a quiz-style hidden answer', () => {
    const src = '<details>\n<summary>View answer</summary>\n\nThe answer is 42.\n\n</details>';
    const { html } = render(src);
    expect(count(html, '</details>')).toBe(1);
  });

  it('does not break a two-column comparison table', () => {
    const src = '<table>\n<tr>\n<td>\n\nBad\n\n</td>\n<td>\n\nGood\n\n</td>\n</tr>\n</table>';
    const { html } = render(src);
    expect(count(html, '</td>')).toBe(2);
    expect(repairs(src)).toEqual([]);
  });

  it('STILL closes a tag that is genuinely never closed anywhere below', () => {
    const src = '<details>\n<summary>Truncated</summary>\n\nBody that never closes.';
    const { html } = render(src);
    expect(html).toContain('</details>');
    expect(codes(src)).toContain('html-escaped-unknown-tag');
  });
});

describe('cluster 2a: emphasis next to CJK punctuation', () => {
  const cases: Array<[string, string]> = [
    ['fullwidth period', '请查看**文档**。'],
    ['fullwidth comma', '使用**工具**，然后运行。'],
    ['mid-sentence', '建议**优先走解读**，不会默认。'],
    ['fullwidth exclamation', '这是**重要**！'],
  ];
  for (const [name, src] of cases) {
    it(`closes bold correctly before a ${name}`, () => {
      const { html } = render(src);
      expect(html).not.toContain('**');
      expect(html).toContain('<strong>');
      expect(repairs(src)).toEqual([]);
    });
  }

  it('STILL auto-closes a genuinely unclosed bold run', () => {
    expect(codes('Some **bold that never closes')).toContain('emphasis-auto-closed');
  });
});

describe('cluster 2c: bold that CommonMark flanking rejects on CJK/Korean', () => {
  // CommonMark's flanking rules are Latin-centric: a closing `**` preceded by
  // punctuation and followed by a letter is refused. In Chinese, Japanese and
  // Korean that shape is completely ordinary, so GitHub renders these as
  // literal asterisks. Pairing them anyway is the clearest case where this
  // parser should beat a strict one.
  const cases: Array<[string, string, string]> = [
    ['fullwidth colon label', '**注意：**本项目不支持', '<strong>注意：</strong>'],
    ['fullwidth colon 2', '**修复：**收敛边界', '<strong>修复：</strong>'],
    ['fullwidth parens', '**捆绑包（bundle）**将一组', '<strong>捆绑包（bundle）</strong>'],
    ['link then CJK', '**[DRCD](https://x.com)**由台湾发布', '</a></strong>由台湾'],
    ['link then Korean', '기여를 **[C](C.md)**를 참고하세요.', '</a></strong>를'],
  ];
  for (const [name, src, expected] of cases) {
    it(`pairs ${name}`, () => {
      const { html } = render(src);
      expect(html).toContain(expected);
      expect(html).not.toContain('**');
    });
  }

  it('does not pair underscores, which are identifiers at this shape', () => {
    expect(render('The __stdcall和__cdecl thing').html).toContain('__stdcall和__cdecl');
  });

  it('does not pair a glob that has no real partner', () => {
    expect(render('Match **/*.ts here').html).toContain('**/*.ts');
  });
});

describe('cluster 2b: escaped brackets are not eaten as LaTeX', () => {
  it('renders \\[!TIP] as a literal bracket, not math', () => {
    const { html } = render('\\[!TIP]\nUse this feature.');
    expect(html).toContain('[!TIP]');
    expect(html).not.toContain('math');
    expect(repairs('\\[!TIP]\nUse this.')).toEqual([]);
  });

  it('renders escaped citation brackets literally', () => {
    const { html } = render('- \\[[arxiv](https://arxiv.org/abs/1)\\] A paper.');
    expect(html).toContain('[');
    expect(html).not.toContain('math math-display');
  });

  it('STILL treats a real \\[ ... \\] block as display math', () => {
    const { html } = render('\\[\n\\frac{a}{b}\n\\]');
    expect(html).toContain('math math-display');
  });

  it('STILL treats real inline \\( ... \\) as math', () => {
    expect(render('where \\(x^2\\) holds').html).toContain('math math-inline');
  });
});

describe('cluster 3: bold-heading promotion is opt-in', () => {
  it('leaves a lone bold line as emphasis by default', () => {
    const src = '**Overview**\n\nSome text.';
    const { html } = render(src);
    expect(html).toContain('<strong>Overview</strong>');
    expect(html).not.toMatch(/<h[1-6]>/);
    expect(repairs(src)).toEqual([]);
  });

  it('promotes it under its own diagnostic code when enabled', () => {
    const src = '**Overview**\n\nSome text.';
    const { html, diagnostics } = render(src, { promoteBoldHeadings: true });
    expect(html).toMatch(/<h[1-6]>Overview<\/h[1-6]>/);
    expect(diagnostics.map((d) => d.code)).toContain('bold-line-heading');
    // No longer mislabelled as a missing-space repair.
    expect(diagnostics.map((d) => d.code)).not.toContain('heading-missing-space');
  });

  it('STILL repairs a genuinely space-missing ATX heading, always', () => {
    expect(codes('##Results\n\nText.')).toContain('heading-missing-space');
  });
});

describe('cluster 4: fuzzy fence closers yield to a real closer below', () => {
  it('does not let a docstring inside a python block close it', () => {
    const src = "```python\ndef f():\n    '''doc'''\n    return 1\n```\n\nAfter.";
    const { html } = render(src);
    expect(html).toContain('return 1');
    expect(html).toContain('<p>After.</p>');
    expect(repairs(src)).toEqual([]);
  });

  it('does not consume the opener of the next block as this block’s closer', () => {
    const src = '```bash\ncmd one\n```\n```json\n{"a":1}\n```\n\nAfter.';
    const { html } = render(src);
    // Two separate code blocks, and the trailing prose is prose.
    expect(count(html, '<pre')).toBe(2);
    expect(html).toContain('<p>After.</p>');
    expect(repairs(src)).toEqual([]);
  });

  it('STILL auto-closes a fence that is truly never closed', () => {
    expect(codes('```js\nconst x = 1;')).toContain('fence-unclosed');
  });
});
