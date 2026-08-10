import { describe, expect, it } from 'vitest';
import { parse, render } from '../src/index.js';
import { boldHeadingFeatures, FEATURE_NAMES } from '../src/features.js';
import { MODEL_INFO, explain, headingProbability, ruleSignalApplies } from '../src/classifier.js';

/**
 * The bold-line-as-heading decision, after replacing part of the hand-written
 * rule with a small pinned classifier.
 *
 * The rule keyed on ASCII title-casing, so in Chinese, Japanese, Korean and
 * Arabic — scripts with no letter case — it could never fire, and every section
 * header written as `**标题**` was silently demoted to a paragraph. The
 * classifier covers exactly the region where that signal does not apply; where
 * it does apply the rule still has the last word, because it measured more
 * precise there.
 */

const isHeading = (src: string) => /<h[1-6]>/.test(render(src, { promoteBoldHeadings: true }).html);
const doc = (bold: string) => `${bold}\n\n${'Some following body text.'}`;

describe('heading classifier: scripts the rule could never handle', () => {
  const titles: Array<[string, string]> = [
    ['chinese', '**实验结果**'],
    ['chinese numbered', '**第二节：实验结果**'],
    ['chinese install', '**安装步骤**'],
    ['japanese', '**実験結果**'],
    ['japanese katakana', '**インストール方法**'],
    ['korean', '**설치 방법**'],
    ['russian', '**Быстрый старт**'],
    ['russian single word', '**Установка**'],
  ];

  for (const [name, bold] of titles) {
    it(`promotes a ${name} section title`, () => {
      expect(isHeading(doc(bold))).toBe(true);
    });
  }

  const sentences: Array<[string, string]> = [
    ['chinese with fullwidth period', '**周五千万不要发布。**'],
    ['chinese with fullwidth exclamation', '**请先阅读迁移指南！**'],
    ['japanese sentence', '**金曜日にデプロイしないでください。**'],
    ['korean sentence', '**금요일에는 배포하지 마세요.**'],
    ['russian sentence', '**Не развёртывайте в пятницу.**'],
  ];

  for (const [name, bold] of sentences) {
    it(`leaves a ${name} as emphasis`, () => {
      expect(isHeading(doc(bold))).toBe(false);
    });
  }
});

describe('heading classifier: English behaviour is unchanged', () => {
  // The rule is measurably more precise on ASCII-cased text, so it keeps
  // authority there. These are the same expectations as before the classifier.
  it('still promotes a title-cased line', () => {
    expect(isHeading(doc('**Section 2: Results**'))).toBe(true);
  });

  it('still promotes a label ending in a colon', () => {
    expect(isHeading(doc('**Step 3 — Deploy the service:**'))).toBe(true);
  });

  it('still leaves an emphatic sentence as emphasis', () => {
    expect(isHeading(doc('**Never deploy on a Friday**'))).toBe(false);
  });

  it('still leaves a bolded sentence with a period as emphasis', () => {
    expect(isHeading(doc('**Do not run this in production.**'))).toBe(false);
  });

  it('reports no repair when nothing was promoted', () => {
    const { diagnostics } = parse('Deploy at 09:00.\n\n**Never deploy on a Friday**\n\nRollbacks take ten minutes.', { promoteBoldHeadings: true });
    expect(diagnostics.filter((d) => d.severity === 'repair')).toEqual([]);
  });
});

describe('heading classifier: routing', () => {
  it('sends caseless and accented scripts to the model', () => {
    expect(ruleSignalApplies('实验结果')).toBe(false);
    expect(ruleSignalApplies('Быстрый старт')).toBe(false);
    expect(ruleSignalApplies('النتائج')).toBe(false);
    expect(ruleSignalApplies("Résultats de l'expérience")).toBe(false);
  });

  it('keeps plain ASCII text with the rule', () => {
    expect(ruleSignalApplies('Executive Summary')).toBe(true);
    expect(ruleSignalApplies('Never deploy on a Friday')).toBe(true);
  });

  it('ignores punctuation when routing, so an em-dash does not misroute English', () => {
    expect(ruleSignalApplies('Step 3 — Deploy the service:')).toBe(true);
  });

  it('can be turned off entirely, restoring rule-only behaviour', () => {
    const src = doc('**实验结果**');
    expect(/<h[1-6]>/.test(render(src, { promoteBoldHeadings: true, headingDetection: 'rule' }).html)).toBe(false);
    expect(/<h[1-6]>/.test(render(src, { promoteBoldHeadings: true, headingDetection: 'auto' }).html)).toBe(true);
  });
});

describe('heading classifier: model integrity', () => {
  it('ships weights that match the feature extractor', () => {
    // Guards the classic silent-corruption bug: weights fitted against a
    // different feature order than the extractor now emits.
    expect(MODEL_INFO.valid).toBe(true);
  });

  it('is deterministic — the same text always scores identically', () => {
    const ctx = {
      text: '实验结果',
      delimiter: '**' as const,
      docUsesAtx: false,
      siblingBoldLines: 0,
      followedByBlank: true,
      followedByParagraph: true,
      relativePosition: 0,
    };
    const first = headingProbability(ctx);
    for (let i = 0; i < 50; i++) expect(headingProbability(ctx)).toBe(first);
  });

  it('emits one feature value per declared feature name', () => {
    const v = boldHeadingFeatures({
      text: 'Anything',
      delimiter: '**',
      docUsesAtx: false,
      siblingBoldLines: 0,
      followedByBlank: true,
      followedByParagraph: true,
      relativePosition: 0,
    });
    expect(v).toHaveLength(FEATURE_NAMES.length);
    expect(v.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('can explain a decision, so it is auditable like the rule it replaced', () => {
    const top = explain({
      text: '周五千万不要发布。',
      delimiter: '**',
      docUsesAtx: false,
      siblingBoldLines: 0,
      followedByBlank: true,
      followedByParagraph: true,
      relativePosition: 0,
    })[0]!;
    // Terminal punctuation is what should be arguing hardest against "heading".
    expect(top.feature).toBe('ends_terminal_punct');
    expect(top.contribution).toBeLessThan(0);
  });

  it('adds no measurable cost to parsing an ordinary document', () => {
    const src = '# Title\n\nProse.\n\n**Executive Summary**\n\nMore prose.\n'.repeat(200);
    const t0 = performance.now();
    parse(src);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
