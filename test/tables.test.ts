import { describe, it, expect } from 'vitest';
import { parse, render } from '../src/index.js';
import type { Block, Diagnostic, Document, Inline, Table, TableRow } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkBlocks(blocks: Block[], visit: (b: Block) => void): void {
  for (const b of blocks) {
    visit(b);
    if (b.type === 'blockquote') walkBlocks(b.children, visit);
    else if (b.type === 'list') walkBlocks(b.children as Block[], visit);
    else if (b.type === 'listItem') walkBlocks(b.children, visit);
  }
}

function findBlocks<T extends Block['type']>(ast: Document, type: T): Extract<Block, { type: T }>[] {
  const out: Block[] = [];
  walkBlocks(ast.children, (b) => {
    if (b.type === type) out.push(b);
  });
  return out as Extract<Block, { type: T }>[];
}

function allTables(ast: Document): Table[] {
  return findBlocks(ast, 'table');
}

function firstTable(ast: Document): Table {
  const tables = allTables(ast);
  expect(tables.length, 'expected the document to contain at least one table').toBeGreaterThan(0);
  return tables[0]!;
}

/** Flatten a cell's inline tree to plain text (code/math contribute their raw value). */
function inlineText(nodes: Inline[]): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
      case 'inlineMath':
      case 'htmlInline':
        out += n.value;
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'softBreak':
        out += ' ';
        break;
      case 'image':
        out += n.alt;
        break;
      default:
        out += inlineText(n.children);
    }
  }
  return out;
}

function rowTexts(row: TableRow): string[] {
  return row.cells.map((c) => inlineText(c.children).trim());
}

function tableTexts(t: Table): string[][] {
  return t.rows.map(rowTexts);
}

function countInline(nodes: Inline[], type: Inline['type']): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === type) n++;
    if ('children' in node) n += countInline(node.children, type);
  }
  return n;
}

const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);

/** Parse and render the same source, so a test can assert on both views. */
function both(src: string): { ast: Document; html: string; diagnostics: Diagnostic[] } {
  const { ast, diagnostics } = parse(src);
  const { html } = render(src);
  return { ast, html, diagnostics };
}

const BT = '```';

// ---------------------------------------------------------------------------
// Fixtures — the taxonomy's literal example inputs
// ---------------------------------------------------------------------------

const F = {
  // 1. missing separator row
  missingSepScores: `| Model | MMLU | GSM8K |
| GPT-4o | 88.7 | 94.2 |
| Claude 3.5 Sonnet | 88.3 | 96.4 |
| Llama 3.1 405B | 85.2 | 89.0 |`,

  missingSepBoldHeader: `**Parameter** | **Type** | **Default**
timeout | int | 30
retries | int | 3
backoff_factor | float | 0.5`,

  captionAboveTable: `| Feature Comparison |
| Feature | Free | Pro |
|---------|------|-----|
| API access | No | Yes |
| SSO | No | Yes |`,

  // 2. separator cell-count mismatch
  sepTooFewCells: `| Endpoint | Method | Auth | Description |
|----------|--------|------|
| /users | GET | Bearer | List all users |
| /users/{id} | DELETE | Bearer | Remove a user |`,

  sepTooManyCells: `| Name | Value |
|------|-------|-------|
| debug_mode | false |
| max_workers | 8 |`,

  sepBareDashRun: `| Quarter | Revenue | YoY |
----------
| Q1 2026 | $4.2M | +18% |
| Q2 2026 | $4.9M | +21% |`,

  // 3. body-row cell-count mismatch
  rowExtraCell: `| Command | Description |
|---------|-------------|
| grep | Search files for a pattern | supports -E for regex |
| ls | List directory contents |`,

  rowMissingTrailingCell: `| Step | Command | Notes |
|------|---------|-------|
| 1 | npm install |
| 2 | npm run build | requires Node 18+ |
| 3 | npm test |`,

  bodyOutvotesHeader: `| Model | Score |
|-------|-------|
| BERT-large | 79.6 | 2018 |
| GPT-2 | 82.1 | 2019 |
| T5-11B | 88.9 | 2019 |
| PaLM | 92.2 | 2022 |`,

  // 4. inconsistent outer pipes
  mixedOuterPipes: `| Metric | Baseline | Ours |
|--------|----------|------|
Accuracy | 91.2 | 94.7
| F1 | 89.0 | 93.1
Recall | 88.4 | 92.9 |`,

  noOuterPipes: `Region | p50 | p99
------ | --- | ---
us-east-1 | 12ms | 87ms
eu-west-1 | 28ms | 141ms`,

  rowLooksLikeListItem: `| Flag | Effect |
|------|--------|
| --verbose | Print debug output |
- --quiet | Suppress all output |`,

  // 5. unicode delimiter / pipe lookalikes
  emDashSeparator: `| Model | Params | Context |
| — | — | — |
| GPT-4o | ~1.8T (rumored) | 128K |
| Claude 3.5 | undisclosed | 200K |`,

  emDashCenterSeparator: `| Metric | Value |
|:—:|:—:|
| Uptime SLA | 99.99% |
| RTO | 15 min |`,

  boxDrawingTable: `│ Service │ Owner  │
├─────────┼────────┤
│ billing │ @maya  │
│ ingest  │ @sam   │`,

  fullwidthPipes: `｜参数｜说明｜
｜---｜---｜
｜timeout｜请求超时秒数｜`,

  emDashInProse: `The run—about 3 hours—failed on shard 3.

We retried it twice.`,

  // 6. alignment colon variants
  alignDoubleColon: `| Item | Price | Stock |
|::|---:|:-:|
| Widget | $9.99 | 214 |`,

  alignInteriorSpaces: `| Name | Score |
| :--- - | ---- : |
| alpha | 92 |`,

  alignEquals: `| Col A | Col B |
|:====:|=====|
| 1 | 2 |`,

  alignInteriorColon: `| Task | Status |
|-:-|-:-|
| deploy | done |`,

  // 7. pipes inside cell content
  pipesInCode: `| Operator | Example |
|----------|---------|
| OR | \`a || b\` |
| pipe to | \`cat access.log | wc -l\` |`,

  pipesInTypeUnion: `| Prop | Type | Default |
|------|------|---------|
| size | "sm" | "md" | "lg" | "md" |
| open | boolean | false |`,

  pipesInMath: `| Symbol | Meaning |
|--------|---------|
| $P(A|B)$ | probability of A given B |
| $x \\mid y$ | x divides y |`,

  escapedPipeInCode: `| Regex | Matches |
|-------|---------|
| \`^(foo\\|bar)$\` | foo or bar |`,

  // 8. blank-line interrupted table
  blankLineContinuation: `| Phase | Owner | ETA |
|-------|-------|-----|
| Design | Maya | Jun 12 |
| Build | Sam | Jul 03 |

| QA | Priya | Jul 21 |
| Launch | Sam | Aug 01 |`,

  blankLineRepeatedHeader: `| File | Coverage |
|------|----------|
| auth.ts | 92% |
| session.ts | 88% |

| File | Coverage |
|------|----------|
| db.ts | 87% |
| cache.ts | 95% |`,

  proseBetweenTableFragments: `| Version | Notes |
|---------|-------|
| 2.1.0 | Adds retry logic |

All versions require Node 18.

| 2.0.0 | Initial GA release |`,

  // 9. inline markup spanning cells
  boldSpansHeaderCells: `| Metric | **Baseline | Improved** |
|--------|-----------|-----------|
| Latency p50 | 240ms | 180ms |`,

  boldUnclosedInCell: `| Status | Meaning |
|--------|---------|
| **CRITICAL | Page the on-call immediately |
| **WARN** | Ticket next business day |`,

  backtickSpansRows: `| Config | Value |
|--------|-------|
| cache_ttl | \`3600 |
| cache_dir | /var/cache\` |`,

  // 10. no blank line before table
  tableGluedToParagraph: `The benchmark results are summarized below:
| Model | Accuracy | F1 |
|-------|----------|----|
| Ours | 94.1% | 93.2% |
| Baseline | 90.8% | 89.5% |`,

  tableInListItem: `- Sprint 14 results:
  | Run | Loss |
  |-----|------|
  | 1 | 0.42 |
  | 2 | 0.37 |`,

  proseAfterTable: `See the required env vars:
| Key | Value |
|-----|-------|
| ENV | prod |
| REGION | us-east-1 |
Restart the service after changing these.`,

  // 11. line breaks inside cells
  brTagsInCells: `| Step | Details |
|------|---------|
| 1 | Install deps<br>Run \`npm ci\`<br/>Verify the lockfile |
| 2 | Deploy<BR>Smoke test |`,

  literalBackslashNInCell: `| Env | Notes |
|-----|-------|
| prod | Primary region: us-east-1\\nFailover: eu-west-1 |
| staging | Single region |`,

  wrappedCellAcrossLines: `| Ticket | Summary |
|--------|---------|
| JIRA-142 | Fix login redirect loop
when the SSO token expires |
| JIRA-155 | Rotate TLS certificates |`,

  // 12. table wrapped in a code fence
  tableInBareFence: [
    'Here is the pricing comparison:',
    '',
    BT,
    '| Tier | Price | Seats |',
    '|------|-------|-------|',
    '| Free | $0 | 3 |',
    '| Team | $12/user | 25 |',
    BT,
  ].join('\n'),

  tableInMarkdownFence: [
    'To demonstrate GFM syntax:',
    '',
    BT + 'markdown',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    BT,
  ].join('\n'),

  tableSwallowedByBashFence: [
    'Run the check:',
    BT + 'bash',
    'kubectl get pods -n prod',
    '',
    '| Pod | Status | Restarts |',
    '|-----|--------|----------|',
    '| api-7f9d | Running | 0 |',
    '| worker-x2 | CrashLoopBackOff | 14 |',
  ].join('\n'),

  // 13. glued / restarted tables
  twoGluedTables: `| Region | Users |
|--------|-------|
| NA | 12,400 |
| EU | 9,800 |
| Metric | Q1 | Q2 |
|--------|----|----|
| Churn | 2.1% | 1.8% |`,

  restartedHeaderWithSeparator: `| File | LOC |
|------|-----|
| main.py | 412 |
| handlers.py | 763 |
| File | LOC |
|------|-----|
| utils.py | 198 |
| cli.py | 87 |`,

  restartedHeaderNoSeparator: `| Test | Result |
|------|--------|
| unit | pass |
| Test | Result |
| integration | flaky |`,

  // 14. ASCII / box-art tables
  plusDashTable: `+---------+--------+----------+
| Service | Status | Restarts |
+---------+--------+----------+
| api     | UP     | 0        |
| worker  | DOWN   | 14       |
+---------+--------+----------+`,

  spaceAlignedTable: `NAME          CPU%    MEMORY
api-server    2.1     512Mi
scheduler     0.4     128Mi
etcd          1.7     1.2Gi`,

  dashUnderlineTable: `Flag        Meaning
-------     ------------------
--force     Skip confirmation
--dry-run   Print actions only`,

  spaceAlignedInsideFence: [
    'Here is the raw output:',
    '',
    BT,
    'NAME          CPU%    MEMORY',
    'api-server    2.1     512Mi',
    'scheduler     0.4     128Mi',
    'etcd          1.7     1.2Gi',
    BT,
  ].join('\n'),

  // 15. truncated at EOF
  truncatedMissingLastCell: `| Model | Context | Price /1M input |
|-------|---------|-----------------|
| gpt-4o | 128K | $2.50 |
| claude-3-5-sonnet | 200K | $3.00 |
| gemini-1.5-pro | 1M |`,

  truncatedMidWord: `| Check | Result |
|-------|--------|
| Lint | pass |
| Type check | pass |
| Unit tests | fa`,

  truncatedHeaderOnly: `Here's the full dependency audit:

| Package | Version | CVE |
|---------|---------|-----|`,

  // guards — well-formed or deliberately literal content
  wellFormedTable: `| Model | Score |
|-------|-------|
| GPT-4o | 88.7 |
| Claude | 88.3 |`,

  wellFormedAlignment: `| Left | Center | Right |
|:-----|:------:|------:|
| a | b | c |`,

  arithmeticInCell: `| Expression | Meaning |
|------------|---------|
| a * b * c | product of three factors |
| 2 * 3 | six |`,

  dollarsInCell: `| Item | Price |
|------|-------|
| Coffee | $5 and $10 |
| Tea | $3 |`,

  hashInCell: `| Rank | Note |
|------|------|
| #1 priority | ship the fix |
| #2 priority | write the postmortem |`,

  pipeInProse: `Use the pattern foo|bar to match either token.

It is a plain sentence, not a table.`,

  listAfterTable: `| A | B |
|---|---|
| 1 | 2 |

- first bullet
- second bullet`,

  shellPipelineInFence: [
    'Count the 404s:',
    '',
    BT + 'bash',
    'cat access.log | grep 404 | wc -l',
    'ps aux | head -5',
    BT,
  ].join('\n'),

  thematicBreakBetweenParagraphs: `Intro paragraph about the release.

---

Next paragraph about the rollout.`,
};

// ---------------------------------------------------------------------------
// Contract: never throws, always returns a document
// ---------------------------------------------------------------------------

describe('tables: parser contract', () => {
  it('returns a document and never throws for every table-shaped input in the corpus', () => {
    for (const [name, src] of Object.entries(F)) {
      expect(() => parse(src), `parse threw on fixture "${name}"`).not.toThrow();
      const { ast, diagnostics } = parse(src);
      expect(ast.type, `fixture "${name}" did not yield a document`).toBe('document');
      expect(Array.isArray(ast.children)).toBe(true);
      expect(Array.isArray(diagnostics)).toBe(true);
      expect(() => render(src), `render threw on fixture "${name}"`).not.toThrow();
    }
  });

  it('returns a document for degenerate pipe fragments without throwing', () => {
    for (const src of ['', '|', '||', '|\n|', '| a |', '|---|', '   |   ', '|\n|---|\n']) {
      const { ast } = parse(src);
      expect(ast.type).toBe('document');
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Missing separator row
// ---------------------------------------------------------------------------

describe('tables: missing separator row', () => {
  it('treats the first row as a header when no separator row exists', () => {
    const { html, diagnostics } = render(F.missingSepScores);
    expect(html).toContain('<th>Model</th>');
    expect(html).toContain('<th>GSM8K</th>');
    expect(html).toContain('<td>GPT-4o</td>');
    expect(codes(diagnostics)).toContain('table-missing-separator');
  });

  it('keeps every data row when synthesizing the missing separator', () => {
    const { ast } = parse(F.missingSepScores);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(4);
    expect(t.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(tableTexts(t)[3]).toEqual(['Llama 3.1 405B', '85.2', '89.0']);
    expect(t.inferredSeparator).toBe(true);
  });

  it('reads a bold-wrapped first row as the header even without outer pipes', () => {
    const { html, diagnostics } = render(F.missingSepBoldHeader);
    expect(html).toContain('<th><strong>Parameter</strong></th>');
    expect(html).toContain('<th><strong>Default</strong></th>');
    expect(html).toContain('<td>backoff_factor</td>');
    expect(html).toContain('<td>0.5</td>');
    expect(codes(diagnostics)).toContain('table-missing-separator');
  });

  it('treats a single-cell first row as a caption, not as the table header', () => {
    const { ast, diagnostics } = parse(F.captionAboveTable);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['Feature', 'Free', 'Pro']);
    expect(t.rows).toHaveLength(3);
    const captions = findBlocks(ast, 'paragraph').map((p) => inlineText(p.children).trim());
    expect(captions).toContain('Feature Comparison');
    expect(codes(diagnostics)).toContain('table-missing-separator');
  });
});

// ---------------------------------------------------------------------------
// 2. Separator row with the wrong cell count
// ---------------------------------------------------------------------------

describe('tables: separator cell-count mismatch', () => {
  it('still builds the table when the separator has too few segments', () => {
    const { html, diagnostics } = render(F.sepTooFewCells);
    expect(html).toContain('<th>Description</th>');
    expect(html).toContain('<td>List all users</td>');
    expect(html).toContain('<td>Remove a user</td>');
    expect(codes(diagnostics)).toContain('table-separator-mismatch');
  });

  it('normalizes the column count to the header when the separator has too few segments', () => {
    const { ast } = parse(F.sepTooFewCells);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.every((r) => r.cells.length === 4)).toBe(true);
    expect(t.align).toHaveLength(4);
  });

  it('drops the surplus separator segment instead of inventing a third column', () => {
    const { ast, diagnostics } = parse(F.sepTooManyCells);
    const t = firstTable(ast);
    expect(t.rows.every((r) => r.cells.length === 2)).toBe(true);
    expect(tableTexts(t)).toEqual([
      ['Name', 'Value'],
      ['debug_mode', 'false'],
      ['max_workers', '8'],
    ]);
    expect(codes(diagnostics)).toContain('table-separator-mismatch');
  });

  it('reads a bare dash run between two pipe rows as a separator, not a thematic break', () => {
    const { ast, html, diagnostics } = both(F.sepBareDashRun);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['Quarter', 'Revenue', 'YoY']);
    expect(t.rows).toHaveLength(3);
    expect(html).not.toContain('<hr />');
    expect(codes(diagnostics)).toContain('table-nonstandard-separator');
  });
});

// ---------------------------------------------------------------------------
// 3. Body rows with the wrong cell count
// ---------------------------------------------------------------------------

describe('tables: ragged body rows', () => {
  it('never drops content when a row has an extra pipe', () => {
    const { ast, diagnostics } = parse(F.rowExtraCell);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    const grep = rowTexts(t.rows[1]!);
    expect(grep).toHaveLength(2);
    expect(grep[0]).toBe('grep');
    expect(grep[1]).toContain('Search files for a pattern');
    expect(grep[1]).toContain('supports -E for regex');
    expect(codes(diagnostics)).toContain('table-ragged-row');
  });

  it('pads short rows with empty trailing cells rather than shifting columns', () => {
    const { ast } = parse(F.rowMissingTrailingCell);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(4);
    expect(t.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(tableTexts(t)[1]).toEqual(['1', 'npm install', '']);
    expect(tableTexts(t)[2]).toEqual(['2', 'npm run build', 'requires Node 18+']);
    expect(tableTexts(t)[3]).toEqual(['3', 'npm test', '']);
  });

  it('widens a too-narrow header when the body consistently has more columns', () => {
    const { html, diagnostics } = render(F.bodyOutvotesHeader);
    expect(html).toContain('<td>2018</td>');
    expect(html).toContain('<td>2022</td>');
    const { ast } = parse(F.bodyOutvotesHeader);
    const t = firstTable(ast);
    expect(t.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(codes(diagnostics)).toContain('table-ragged-row');
  });

  it('does not silently truncate the extra column in the rendered output', () => {
    const { html } = render(F.bodyOutvotesHeader);
    for (const year of ['2018', '2019', '2022']) expect(html).toContain(year);
  });
});

// ---------------------------------------------------------------------------
// 4. Inconsistent leading/trailing pipes
// ---------------------------------------------------------------------------

describe('tables: inconsistent outer pipes', () => {
  it('keeps rows of four different piping styles in one table with equal cell counts', () => {
    const { ast } = parse(F.mixedOuterPipes);
    const t = firstTable(ast);
    expect(allTables(ast)).toHaveLength(1);
    expect(t.rows).toHaveLength(4);
    expect(t.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(tableTexts(t)[1]).toEqual(['Accuracy', '91.2', '94.7']);
    expect(tableTexts(t)[3]).toEqual(['Recall', '88.4', '92.9']);
  });

  it('accepts a fully unpiped table without reporting any repair (legal GFM)', () => {
    const { html, diagnostics } = render(F.noOuterPipes);
    expect(html).toContain('<th>Region</th>');
    expect(html).toContain('<td>us-east-1</td>');
    expect(html).toContain('<td>141ms</td>');
    expect(diagnostics).toEqual([]);
  });

  it('consumes a row that starts with a list marker as a table row, not a list item', () => {
    const { html, ast } = both(F.rowLooksLikeListItem);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(rowTexts(t.rows[2]!)[1]).toBe('Suppress all output');
    expect(html).toContain('Suppress all output');
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<li>');
  });
});

// ---------------------------------------------------------------------------
// 5. Unicode delimiter and pipe lookalikes
// ---------------------------------------------------------------------------

describe('tables: unicode delimiter and pipe lookalikes', () => {
  it('accepts an em-dash separator row as a normal delimiter', () => {
    const { html, diagnostics } = render(F.emDashSeparator);
    expect(html).toContain('<th>Model</th>');
    expect(html).toContain('<td>GPT-4o</td>');
    expect(html).toContain('<td>200K</td>');
    expect(codes(diagnostics)).toContain('table-nonstandard-separator');
  });

  it('reads ":—:" as center alignment', () => {
    const { ast } = parse(F.emDashCenterSeparator);
    const t = firstTable(ast);
    expect(t.align).toEqual(['center', 'center']);
    expect(tableTexts(t)[1]).toEqual(['Uptime SLA', '99.99%']);
  });

  it('parses a box-drawing table into a real two-column table', () => {
    const { ast } = parse(F.boxDrawingTable);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['Service', 'Owner']);
    expect(t.rows).toHaveLength(3);
    expect(tableTexts(t)[1]).toEqual(['billing', '@maya']);
    expect(tableTexts(t)[2]).toEqual(['ingest', '@sam']);
  });

  it('parses fullwidth pipes as cell delimiters', () => {
    const { ast, html } = both(F.fullwidthPipes);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['参数', '说明']);
    expect(tableTexts(t)[1]).toEqual(['timeout', '请求超时秒数']);
    expect(html).toContain('<table>');
  });

  it('never turns em-dashes in ordinary prose into table syntax', () => {
    const { html, ast } = both(F.emDashInProse);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('<p>');
    expect(html).toContain('The run—about 3 hours—failed on shard 3.');
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed alignment colons
// ---------------------------------------------------------------------------

describe('tables: malformed alignment colons', () => {
  it('reads "::" as center and keeps the rest of the alignment row', () => {
    const { ast } = parse(F.alignDoubleColon);
    const t = firstTable(ast);
    expect(t.align).toEqual(['center', 'right', 'center']);
    expect(tableTexts(t)[1]).toEqual(['Widget', '$9.99', '214']);
  });

  it('ignores stray interior spaces inside delimiter cells', () => {
    const { ast } = parse(F.alignInteriorSpaces);
    const t = firstTable(ast);
    expect(t.align).toEqual(['left', 'right']);
    expect(tableTexts(t)).toEqual([
      ['Name', 'Score'],
      ['alpha', '92'],
    ]);
  });

  it('treats "=" runs in the delimiter exactly like "-" runs', () => {
    const { ast } = parse(F.alignEquals);
    const t = firstTable(ast);
    expect(t.align).toEqual(['center', null]);
    expect(tableTexts(t)).toEqual([
      ['Col A', 'Col B'],
      ['1', '2'],
    ]);
  });

  it('reads an interior colon "-:-" as center alignment', () => {
    const { ast } = parse(F.alignInteriorColon);
    const t = firstTable(ast);
    expect(t.align).toEqual(['center', 'center']);
    expect(tableTexts(t)[1]).toEqual(['deploy', 'done']);
  });
});

// ---------------------------------------------------------------------------
// 7. Pipes inside cell content
// ---------------------------------------------------------------------------

describe('tables: pipes inside cell content', () => {
  it('does not split cells on pipes inside inline code spans', () => {
    const { ast } = parse(F.pipesInCode);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.every((r) => r.cells.length === 2)).toBe(true);
    expect(rowTexts(t.rows[1]!)[1]).toBe('a || b');
    expect(rowTexts(t.rows[2]!)[1]).toBe('cat access.log | wc -l');
  });

  it('renders a shell pipeline cell as one code span', () => {
    const { html } = render(F.pipesInCode);
    expect(html).toContain('<code>cat access.log | wc -l</code>');
  });

  it('merges a type union back into a single Type cell', () => {
    const { ast, diagnostics } = parse(F.pipesInTypeUnion);
    const t = firstTable(ast);
    const size = rowTexts(t.rows[1]!);
    expect(size).toHaveLength(3);
    expect(size[0]).toBe('size');
    expect(size[1]).toContain('"sm"');
    expect(size[1]).toContain('"lg"');
    expect(size[2]).toBe('"md"');
    expect(codes(diagnostics)).toContain('table-ragged-row');
  });

  it('does not split a cell on a pipe inside inline math', () => {
    const { ast } = parse(F.pipesInMath);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.every((r) => r.cells.length === 2)).toBe(true);
    expect(rowTexts(t.rows[1]!)[0]).toContain('P(A|B)');
    expect(rowTexts(t.rows[1]!)[1]).toBe('probability of A given B');
  });

  it('renders an escaped \\| inside a code span as a literal pipe (GFM table quirk)', () => {
    const { ast, html } = both(F.escapedPipeInCode);
    const t = firstTable(ast);
    expect(t.rows[1]!.cells).toHaveLength(2);
    expect(html).toContain('<code>^(foo|bar)$</code>');
    expect(html).toContain('<td>foo or bar</td>');
  });
});

// ---------------------------------------------------------------------------
// 8. Table interrupted by a blank line
// ---------------------------------------------------------------------------

describe('tables: blank line inside a table', () => {
  it('rejoins body rows that continue after a stray blank line', () => {
    const { ast, diagnostics } = parse(F.blankLineContinuation);
    expect(allTables(ast)).toHaveLength(1);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(5);
    expect(tableTexts(t)[4]).toEqual(['Launch', 'Sam', 'Aug 01']);
    expect(codes(diagnostics)).toContain('table-merged-continuation');
  });

  it('deduplicates a header re-emitted verbatim after a blank line', () => {
    const { ast, html } = both(F.blankLineRepeatedHeader);
    expect(allTables(ast)).toHaveLength(1);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(5);
    expect(tableTexts(t).slice(1).map((r) => r[0])).toEqual(['auth.ts', 'session.ts', 'db.ts', 'cache.ts']);
    expect(html).not.toContain('<td>File</td>');
  });

  it('never leapfrogs intervening prose to absorb a later pipe row', () => {
    const { ast, html } = both(F.proseBetweenTableFragments);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(2);
    expect(tableTexts(t)[1]).toEqual(['2.1.0', 'Adds retry logic']);
    expect(html).toContain('<p>All versions require Node 18.</p>');
    expect(html).toContain('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// 9. Inline markup spanning cells
// ---------------------------------------------------------------------------

describe('tables: inline markup spanning cells', () => {
  it('closes bold at the cell boundary so both header cells render bold', () => {
    const { html } = render(F.boldSpansHeaderCells);
    expect(html).toContain('<th><strong>Baseline</strong></th>');
    expect(html).toContain('<th><strong>Improved</strong></th>');
    expect(html).not.toContain('**');
  });

  it('auto-closes an unterminated bold marker inside a body cell', () => {
    const { html, diagnostics } = render(F.boldUnclosedInCell);
    expect(html).toContain('<td><strong>CRITICAL</strong></td>');
    expect(html).toContain('<td><strong>WARN</strong></td>');
    expect(html).toContain('Page the on-call immediately');
    expect(html).not.toContain('**');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });

  it('never lets a code span leak across a row boundary', () => {
    const { ast, html } = both(F.backtickSpansRows);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(t.rows.every((r) => r.cells.length === 2)).toBe(true);
    expect(html).toContain('<code>3600</code>');
    expect(html).toContain('/var/cache');
    expect(rowTexts(t.rows[1]!)[0]).toBe('cache_ttl');
    expect(rowTexts(t.rows[2]!)[0]).toBe('cache_dir');
  });
});

// ---------------------------------------------------------------------------
// 10. No blank line before/after the table
// ---------------------------------------------------------------------------

describe('tables: missing blank line around a table', () => {
  it('lets a table interrupt the paragraph directly above it', () => {
    const { html, diagnostics } = render(F.tableGluedToParagraph);
    expect(html).toContain('<p>The benchmark results are summarized below:</p>');
    expect(html).toContain('<th>Accuracy</th>');
    expect(html).toContain('<td>90.8%</td>');
    expect(codes(diagnostics)).toContain('table-interrupts-paragraph');
  });

  it('keeps an indented table inside its list item', () => {
    const { ast } = parse(F.tableInListItem);
    const lists = findBlocks(ast, 'list');
    expect(lists).toHaveLength(1);
    const item = lists[0]!.children[0]!;
    const nested = item.children.filter((c) => c.type === 'table');
    expect(nested).toHaveLength(1);
    expect(tableTexts(nested[0] as Table)).toEqual([
      ['Run', 'Loss'],
      ['1', '0.42'],
      ['2', '0.37'],
    ]);
  });

  it('closes the table at the first pipeless prose line instead of padding it into a row', () => {
    const { ast, html } = both(F.proseAfterTable);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    expect(html).toContain('<p>Restart the service after changing these.</p>');
    expect(html).not.toContain('<td>Restart the service after changing these.</td>');
  });
});

// ---------------------------------------------------------------------------
// 11. Line breaks inside cells
// ---------------------------------------------------------------------------

describe('tables: line breaks inside cells', () => {
  it('turns <br>, <br/> and <BR> inside cells into hard breaks', () => {
    const { ast, html } = both(F.brTagsInCells);
    const t = firstTable(ast);
    expect(countInline(t.rows[1]!.cells[1]!.children, 'hardBreak')).toBe(2);
    expect(countInline(t.rows[2]!.cells[1]!.children, 'hardBreak')).toBe(1);
    expect(html).toContain('Verify the lockfile');
    expect(html).toContain('<code>npm ci</code>');
    expect(html).toContain('Smoke test');
  });

  it('turns a literal backslash-n inside a cell into a hard break', () => {
    const { ast } = parse(F.literalBackslashNInCell);
    const t = firstTable(ast);
    const notes = t.rows[1]!.cells[1]!;
    expect(countInline(notes.children, 'hardBreak')).toBe(1);
    const text = inlineText(notes.children);
    expect(text).toContain('Primary region: us-east-1');
    expect(text).toContain('Failover: eu-west-1');
    expect(text).not.toContain('\\n');
  });

  it('folds a pipeless continuation line into the previous row rather than closing the table', () => {
    const { ast } = parse(F.wrappedCellAcrossLines);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(3);
    const summary = rowTexts(t.rows[1]!)[1]!;
    expect(summary).toContain('Fix login redirect loop');
    expect(summary).toContain('when the SSO token expires');
    expect(tableTexts(t)[2]).toEqual(['JIRA-155', 'Rotate TLS certificates']);
  });
});

// ---------------------------------------------------------------------------
// 12. Table wrapped in a code fence
// ---------------------------------------------------------------------------

describe('tables: tables and code fences', () => {
  it('unwraps a table that was reflexively put in an untagged fence', () => {
    const { ast, html } = both(F.tableInBareFence);
    expect(allTables(ast)).toHaveLength(1);
    expect(html).toContain('<th>Tier</th>');
    expect(html).toContain('<td>$12/user</td>');
    expect(html).not.toContain('<pre>');
  });

  it('leaves a ```markdown fence showing table SOURCE as a code block', () => {
    const { ast, html } = both(F.tableInMarkdownFence);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('<code class="language-markdown">');
    expect(html).toContain('|---|---|');
    expect(html).not.toContain('<table>');
  });

  it('closes an unterminated bash fence before a table start signature', () => {
    const { ast, html, diagnostics } = both(F.tableSwallowedByBashFence);
    const code = findBlocks(ast, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.value).toContain('kubectl get pods -n prod');
    expect(code[0]!.value).not.toContain('CrashLoopBackOff');
    expect(html).toContain('<th>Restarts</th>');
    expect(html).toContain('<td>CrashLoopBackOff</td>');
    expect(codes(diagnostics)).toContain('fence-unclosed');
  });
});

// ---------------------------------------------------------------------------
// 13. Glued or restarted tables
// ---------------------------------------------------------------------------

describe('tables: glued and restarted tables', () => {
  it('splits two glued tables at the second delimiter row', () => {
    const { ast } = parse(F.twoGluedTables);
    const ts = allTables(ast);
    expect(ts).toHaveLength(2);
    expect(tableTexts(ts[0]!)).toEqual([
      ['Region', 'Users'],
      ['NA', '12,400'],
      ['EU', '9,800'],
    ]);
    expect(rowTexts(ts[1]!.rows[0]!)).toEqual(['Metric', 'Q1', 'Q2']);
    expect(tableTexts(ts[1]!)[1]).toEqual(['Churn', '2.1%', '1.8%']);
  });

  it('does not render a delimiter row as a table body row full of dashes', () => {
    const { html } = render(F.twoGluedTables);
    expect(html).not.toContain('<td>--------</td>');
    expect(html).not.toContain('<td>----</td>');
  });

  it('drops a restarted header+delimiter that repeats the current header', () => {
    const { ast } = parse(F.restartedHeaderWithSeparator);
    expect(allTables(ast)).toHaveLength(1);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(5);
    expect(tableTexts(t).slice(1).map((r) => r[0])).toEqual(['main.py', 'handlers.py', 'utils.py', 'cli.py']);
  });

  it('drops a bare header re-emission that has no delimiter after it', () => {
    const { ast } = parse(F.restartedHeaderNoSeparator);
    const t = firstTable(ast);
    expect(tableTexts(t)).toEqual([
      ['Test', 'Result'],
      ['unit', 'pass'],
      ['integration', 'flaky'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 14. ASCII / box-art tables
// ---------------------------------------------------------------------------

describe('tables: ASCII art tables', () => {
  it('converts a +---+ bordered table into a real table', () => {
    const { ast, html } = both(F.plusDashTable);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['Service', 'Status', 'Restarts']);
    expect(t.rows).toHaveLength(3);
    expect(tableTexts(t)[1]).toEqual(['api', 'UP', '0']);
    expect(tableTexts(t)[2]).toEqual(['worker', 'DOWN', '14']);
    expect(html).not.toContain('+---------+');
  });

  // DECLINED: whitespace alignment alone is not evidence of a table — adopting
  // it would turn any indented block of text into one. A dash underline with
  // visible column gaps IS supported (see the test below). README non-goals.
  it.skip('converts space-aligned terminal output into a table', () => {
    const { ast } = parse(F.spaceAlignedTable);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['NAME', 'CPU%', 'MEMORY']);
    expect(t.rows).toHaveLength(4);
    expect(tableTexts(t)[3]).toEqual(['etcd', '1.7', '1.2Gi']);
  });

  it('reads a dash underline under a space-aligned header as the separator', () => {
    const { ast } = parse(F.dashUnderlineTable);
    const t = firstTable(ast);
    expect(rowTexts(t.rows[0]!)).toEqual(['Flag', 'Meaning']);
    expect(t.rows).toHaveLength(3);
    expect(tableTexts(t)[1]).toEqual(['--force', 'Skip confirmation']);
    expect(tableTexts(t)[2]).toEqual(['--dry-run', 'Print actions only']);
  });

  it('leaves space-aligned output inside a code fence verbatim', () => {
    const { ast, html } = both(F.spaceAlignedInsideFence);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('<pre>');
    expect(html).toContain('api-server    2.1     512Mi');
  });
});

// ---------------------------------------------------------------------------
// 15. Truncated tables
// ---------------------------------------------------------------------------

describe('tables: truncation at EOF', () => {
  it('pads the final row when generation stopped before the last cell', () => {
    const { ast } = parse(F.truncatedMissingLastCell);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(4);
    expect(rowTexts(t.rows[3]!)).toEqual(['gemini-1.5-pro', '1M', '']);
    expect(tableTexts(t)[2]).toEqual(['claude-3-5-sonnet', '200K', '$3.00']);
  });

  it('keeps a partial final cell verbatim when the stream died mid-word', () => {
    const { ast, html } = both(F.truncatedMidWord);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(4);
    expect(rowTexts(t.rows[3]!)).toEqual(['Unit tests', 'fa']);
    expect(html).toContain('<td>Unit tests</td>');
  });

  it('emits a table for a header+delimiter with no body rows yet', () => {
    const { ast, html } = both(F.truncatedHeaderOnly);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(1);
    expect(rowTexts(t.rows[0]!)).toEqual(['Package', 'Version', 'CVE']);
    expect(html).toContain('<th>CVE</th>');
    expect(html).not.toContain('<p>| Package');
  });
});

// ---------------------------------------------------------------------------
// Guards — well-formed or deliberately literal input must not be "repaired"
// ---------------------------------------------------------------------------

describe('tables: guards against over-eager repair', () => {
  it('parses a well-formed GFM table with no diagnostics at all', () => {
    const { html, diagnostics } = render(F.wellFormedTable);
    expect(html).toContain('<th>Model</th>');
    expect(html).toContain('<td>88.3</td>');
    expect(diagnostics).toEqual([]);
  });

  it('honors standard alignment colons without reporting a repair', () => {
    const { ast, diagnostics } = parse(F.wellFormedAlignment);
    const t = firstTable(ast);
    expect(t.align).toEqual(['left', 'center', 'right']);
    expect(diagnostics).toEqual([]);
  });

  it('leaves "a * b * c" arithmetic in a cell as literal text, not emphasis', () => {
    const { html } = render(F.arithmeticInCell);
    expect(html).toContain('a * b * c');
    expect(html).not.toContain('<em>');
    expect(html).toContain('2 * 3');
  });

  it('leaves "$5 and $10" in a cell as currency, not math', () => {
    const { html } = render(F.dollarsInCell);
    expect(html).toContain('$5 and $10');
    expect(html).not.toContain('math-inline');
  });

  it('leaves "#1 priority" in a cell as text, not a heading', () => {
    const { html, ast } = both(F.hashInCell);
    expect(html).toContain('#1 priority');
    expect(findBlocks(ast, 'heading')).toHaveLength(0);
    expect(html).not.toContain('<h1>');
  });

  it('does not turn a prose sentence containing one pipe into a table', () => {
    const { ast, html } = both(F.pipeInProse);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('Use the pattern foo|bar to match either token.');
    expect(html).toContain('<p>');
  });

  it('lets a genuine list after a table stay a list', () => {
    const { ast, html } = both(F.listAfterTable);
    const t = firstTable(ast);
    expect(t.rows).toHaveLength(2);
    expect(findBlocks(ast, 'list')).toHaveLength(1);
    expect(html).toContain('<li>first bullet</li>');
    expect(html).toContain('<li>second bullet</li>');
  });

  it('does not convert a shell pipeline inside a code fence into a table', () => {
    const { ast, html, diagnostics } = both(F.shellPipelineInFence);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('cat access.log | grep 404 | wc -l');
    expect(html).not.toContain('<table>');
    expect(diagnostics).toEqual([]);
  });

  it('keeps a standalone --- between paragraphs a thematic break, not a table separator', () => {
    const { ast, html } = both(F.thematicBreakBetweenParagraphs);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Next paragraph about the rollout.</p>');
  });

  it('does not treat an escaped \\| in prose as a table delimiter', () => {
    const src = `The escape sequence \\| renders as a literal pipe character.`;
    const { ast, html } = both(src);
    expect(allTables(ast)).toHaveLength(0);
    expect(html).toContain('<p>');
  });
});
