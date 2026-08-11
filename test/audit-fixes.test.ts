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

  it('sees a closer that lives outside the list item the tag opened in', () => {
    // The closer index must be document-scoped: block parsing recurses on
    // sliced line arrays, and a <details> opened inside a list item routinely
    // closes outside it. A slice-scoped index cannot see that and force-closes.
    const src = ['- Item one', '  <details>', '  <summary>Go SDK</summary>', '', '  install steps', '', '- Item two', '', '</details>', '', 'After.'].join('\n');
    expect(count(render(src).html, '</details>')).toBe(1);
    expect(repairs(src)).toEqual([]);
  });

  it('does not invent closers from commented-out markup', () => {
    // `<!-- <Flowchart> -->` was producing a fabricated </flowchart>, and a
    // commented-out <table> got a </table> injected into live output.
    expect(repairs('<!-- <Main description> -->\n\nText.')).toEqual([]);
    expect(render('<!--\n<table><tr><td>x</td></tr>\n-->\n\nText.').html).not.toContain('</table>');
  });

  it('reads a self-closing tag with attributes as self-closing', () => {
    // `<a name="11"/>` is not an unclosed anchor.
    expect(repairs('<a name="11"/>\n\n# Heading')).toEqual([]);
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

describe('cluster 5: setext headings are not demoted to paragraph + rule', () => {
  const h2 = (src: string) => render(src).html;

  it('keeps a lowercase section title', () => {
    expect(h2('Fuzzy completion\n----------------')).toContain('<h2>Fuzzy completion</h2>');
  });

  it('keeps a colon-terminated title', () => {
    expect(h2('Environment:\n---')).toContain('<h2>Environment:</h2>');
    expect(h2('Models Detail:\n---')).toContain('<h2>Models Detail:</h2>');
  });

  it('keeps a CJK title, which no ASCII title-case test can recognize', () => {
    const src = '中文任务基准测评(ChineseGLUE)-排行榜 Leaderboard\n---';
    expect(h2(src)).toMatch(/<h2>中文任务基准测评/);
    expect(h2(src)).not.toContain('<hr />');
  });

  it('keeps a long multi-word title', () => {
    expect(h2('Parser Interface (backwards compat prior to REST)\n---')).toMatch(/<h2>Parser Interface/);
  });

  it('keeps a setext heading in a document that otherwise uses ATX', () => {
    const src = '# Title\n\n## Real ATX\n\ntext\n\nSection A\n---\n\nmore';
    expect(h2(src)).toContain('<h2>Section A</h2>');
  });

  it('keeps question-form FAQ headings, which are a README staple', () => {
    // Every one of these is a real section heading from the audit corpus that
    // a `?`-terminates-a-sentence rule demoted to a paragraph plus a rule,
    // breaking the in-document anchor that linked to it.
    for (const t of ['Why Ramda?', 'What is this?', 'Why C?', 'Is this a fork?',
                     "What's with the name?", 'WANT TO CONTRIBUTE?',
                     '为什么我们需要一个中文任务的基准测试？']) {
      const { html } = render(`${t}\n---`);
      expect(html, t).toContain('<h2>');
      expect(html, t).not.toContain('<hr />');
    }
  });

  it('keeps a heading ending in an exclamation or an ellipsis', () => {
    expect(h2('I want to keep track of how Brackets is doing!\n---')).toContain('<h2>');
    expect(h2('Coming soon...\n---')).toContain('<h2>');
  });

  it('STILL reads dashes after a finished sentence as a rule', () => {
    const src = 'Restart Claude Code to apply the new mode configuration.\n---';
    const { html } = render(src);
    expect(html).toContain('<hr />');
    expect(html).not.toMatch(/<h[12]>Restart/);
    expect(repairs(src).map((d) => d.code)).toContain('setext-vs-break-ambiguity');
  });

  it('STILL reads dashes after a multi-line paragraph as a rule', () => {
    expect(h2('one line of prose\nand a second line\n---')).toContain('<hr />');
  });
});

describe('cluster 6: pipe lookalikes are content when the row has real pipes', () => {
  it('keeps a fullwidth pipe inside a cell as punctuation', () => {
    const src = '| 标题 |\n| --- |\n| 清醒FM｜Gen Z 迷茫图鉴 |';
    const { html } = render(src);
    expect(html).toContain('清醒FM｜Gen Z 迷茫图鉴');
    expect(count(html, '<td')).toBe(1);
    expect(repairs(src)).toEqual([]);
  });

  it('keeps a box-drawing bar inside a cell as decoration', () => {
    const src = '| Name | Links |\n| --- | --- |\n| Day 1 | [Challenge](a) │ [Solution](b) |';
    const { html } = render(src);
    expect(count(html, '<td')).toBe(2);
    expect(repairs(src)).toEqual([]);
  });

  it('STILL parses a table delimited entirely by fullwidth pipes', () => {
    const { html } = render('｜ A ｜ B ｜\n｜ --- ｜ --- ｜\n｜ 1 ｜ 2 ｜');
    expect(count(html, '<td')).toBe(2);
    expect(html).toContain('<th>A</th>');
  });

  it('STILL parses a box-drawn table', () => {
    const { html } = render('┌─────┬─────┐\n│ A   │ B   │\n├─────┼─────┤\n│ 1   │ 2   │\n└─────┴─────┘');
    expect(html).toContain('<table>');
    expect(count(html, '<td')).toBe(2);
  });
});

describe('cluster 7: table rows are never folded away', () => {
  it('keeps a row that merely omits a trailing column', () => {
    // 'tesseract-ocr' has no build number and starts lowercase; folding it
    // into the row above deleted the entry outright.
    const src = [
      '| Program | Website | Build # |',
      '| --- | --- | --- |',
      '| terminator | term.org | 17134 |',
      '| tesseract-ocr | tesseract.org |',
      '| tmux | tmux.org | 14393 |',
    ].join('\n');
    const { html } = render(src);
    expect(html).toContain('tesseract-ocr');
    expect(count(html, '<tr')).toBe(4); // header + 3 body rows, none swallowed
    expect(html).not.toMatch(/terminator[^<]*tesseract/);
  });

  it('does not let a stray trailing || widen the table', () => {
    const src = [
      '| Feature | Status |',
      '| --- | --- |',
      '| alpha | done ||',
      '| beta | wip ||',
    ].join('\n');
    const { html } = render(src);
    expect(count(html, '<th>')).toBe(2);
    expect(count(html, '<td')).toBe(4);
    expect(html).toContain('<td>done</td>');
    expect(repairs(src)).toEqual([]);
  });

  it('STILL folds a genuine wrapped cell that has no pipes of its own', () => {
    const src = [
      '| Option | Description |',
      '| --- | --- |',
      '| --verbose | prints a great deal of detail about',
      'every step of the process |',
    ].join('\n');
    const { html } = render(src);
    expect(html).toContain('every step of the process');
    expect(count(html, '<tr')).toBe(2);
  });

  it('merges row overflow at the end, where the author added it', () => {
    // A 2-column table whose rows carry an extra trailing [PDF] link: the
    // title must stay in column 1, not get fused to the description.
    const src = [
      '| Paper | Key Contribution |',
      '|-------|-----------------|',
      '| [Chain of Draft](a) | 5 words per step | [PDF](b) |',
      '| [Latent Reasoning](c) | fewer tokens | [PDF](d) |',
    ].join('\n');
    const { html } = render(src);
    expect(html).toContain('<td><a href="a">Chain of Draft</a></td>');
    expect(html).not.toMatch(/<td>[^<]*Chain of Draft[^|]*\|/);
  });

  it('breaks a merge tie rightmost when one row gives no shape profile', () => {
    const src = '| A | B |\n| --- | --- |\n| one | two | three |';
    const { html } = render(src);
    expect(html).toContain('<td>one</td>');
    expect(html).toContain('two | three');
  });

  it('does not render a commented-out row as cell text', () => {
    const src = [
      '| Target | Supported |',
      '| --- | --- |',
      '| linux | yes |',
      '<!-- | windows | yes | -->',
      '| macos | yes |',
    ].join('\n');
    const { html } = render(src);
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('windows');
    expect(html).toContain('macos');
  });

  it('STILL reattaches rows split off by a stray blank line', () => {
    const src = [
      '| API | Description |',
      '| --- | --- |',
      '| ZipCodeAPI | postal lookup |',
      '',
      '| Zippopotam | postal lookup |',
      '| Ziptastic | postal lookup |',
    ].join('\n');
    const { html } = render(src);
    expect(count(html, '<table')).toBe(1);
    expect(count(html, '<tr')).toBe(4);
    expect(repairs(src).map((d) => d.code)).toContain('table-merged-continuation');
  });
});

describe('cluster 8: list indent repairs never touch fenced content', () => {
  it('does not re-indent lines inside an absorbed fence', () => {
    // `looksLikeCommand` was asked line by line with no idea it was inside a
    // fence, so it indented `cd app` and left the long line at column 0,
    // shredding the block it was attaching.
    const src = [
      '1. Clone it',
      '```bash',
      'git remote set-url origin https://github.com/example/a-very-long-name.git',
      'cd app',
      '```',
      '2. Build it',
    ].join('\n');
    const { html } = render(src);
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '';
    expect(code).toContain('git remote set-url');
    expect(code).toContain('cd app');
    // Neither line gained indentation the author did not write.
    for (const line of code.split('\n').filter(Boolean)) expect(line).not.toMatch(/^ /);
  });

  it('leaves a JSDoc block inside a fenced ts example alone', () => {
    // ` * ` continuation lines were read as list markers and re-striped.
    const src = [
      '- Example:',
      '```ts',
      '/**',
      ' * The standard app config.',
      ' */',
      'export const a = 1;',
      '```',
      '- Next',
    ].join('\n');
    const { html } = render(src);
    expect(html).toContain(' * The standard app config.');
    expect(html).toContain(' */');
  });

  it('indents a bare command run uniformly or not at all', () => {
    const src = [
      '1. Set the remote',
      '',
      'git remote set-url origin https://github.com/example/some-quite-long-name.git',
      'git checkout -b dev',
      '',
      '2. Done',
    ].join('\n');
    const { html } = render(src);
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '';
    const lines = code.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(1);
    const indents = new Set(lines.map((l) => /^\s*/.exec(l)![0].length));
    expect(indents.size).toBe(1);
  });
});

describe('cluster 8b: only an attached block is absorbed into a list item', () => {
  it('leaves a blank-line-separated fence as a sibling of the list', () => {
    const src = ['1. First step', '', '```bash', 'npm install', '```', '', '2. Second step'].join('\n');
    expect(repairs(src)).toEqual([]);
  });

  it('STILL absorbs a fence attached with no blank line', () => {
    // The Awesome-WAF shape: each bullet's payload directly under it.
    const src = ['- [Bypass A](https://x.com/a)', '```', "1'UNION/*!0SELECT", '```', '- [Bypass B](https://x.com/b)'].join('\n');
    expect(repairs(src).map((d) => d.code)).toContain('list-indent-adjusted');
  });

  it('STILL rescues bare commands left flush-left between steps', () => {
    const src = ['1. Install', '', 'npm install', '', '2. Run'].join('\n');
    expect(repairs(src).map((d) => d.code)).toContain('list-indent-adjusted');
  });
});

describe('cluster 8c: an italic lead-in is not a bullet', () => {
  it('renders *Note*: text as emphasis, not a list item', () => {
    const src = '*Note*: I already ran this script.\n*Tip*: run it twice.';
    const { html } = render(src);
    expect(html).toContain('<em>Note</em>');
    expect(html).not.toContain('<li>');
  });

  it('STILL treats a run of -Item bullets as a list', () => {
    const { html } = render('-First\n-Second\n-Third');
    expect(count(html, '<li>')).toBe(3);
  });
});
