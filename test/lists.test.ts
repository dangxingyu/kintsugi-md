import { describe, it, expect } from 'vitest';
import { parse, render } from '../src/index.js';
import type { Block, Diagnostic, Document, List, ListItem } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers — walk the AST rather than string-matching whole documents.
// ---------------------------------------------------------------------------

const BLOCK_CONTAINERS = new Set(['document', 'list', 'listItem', 'blockquote']);

/** Every list node anywhere in the tree, in document order. */
function allLists(node: any, out: List[] = []): List[] {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'list') out.push(node as List);
  if (Array.isArray(node.children)) for (const c of node.children) allLists(c, out);
  return out;
}

/** Only the lists that are direct children of the document. */
function topLists(doc: Document): List[] {
  return doc.children.filter((b) => b.type === 'list') as List[];
}

/** Every block of a given type anywhere in the tree. */
function allBlocks<T extends Block['type']>(node: any, type: T, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) for (const c of node.children) allBlocks(c, type, out);
  return out;
}

/** Flattened visible text of a node, including code-block bodies. */
function textOf(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text' || node.type === 'inlineCode') return String(node.value ?? '');
  if (node.type === 'codeBlock' || node.type === 'mathBlock') return String(node.value ?? '');
  if (node.type === 'softBreak' || node.type === 'hardBreak') return '\n';
  if (Array.isArray(node.children)) {
    return node.children.map(textOf).join(BLOCK_CONTAINERS.has(node.type) ? '\n' : '');
  }
  return '';
}

function itemTexts(list: List): string[] {
  return list.children.map((it) => textOf(it).replace(/\s+/g, ' ').trim());
}

/** The sub-list directly inside a list item, if any. */
function subList(item: ListItem): List | undefined {
  return item.children.find((c) => c.type === 'list') as List | undefined;
}

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

const LIST_CODES = [
  'list-unicode-bullet',
  'list-paren-number',
  'list-indent-adjusted',
  'list-nonsequential-numbers',
  'task-marker-nonstandard',
];

/** List-area repairs only — used by guard tests that must not be "fixed". */
function listRepairs(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => LIST_CODES.includes(d.code)).map((d) => d.code);
}

// ---------------------------------------------------------------------------
// Inputs — the literal snippets from the taxonomy, plus guards.
// ---------------------------------------------------------------------------

const EX = {
  // mixed-indent-units
  mixedIndentDrift: `1. Clone the repository
2. Install dependencies:
  - pip install -r requirements.txt
   - pip install -e .
    - python setup.py develop (legacy alternative)
3. Run the test suite`,
  tabAndSpaceChildren: `- Backend tasks
\t- Migrate the users table to UUID keys
  - Add rate limiting to /api/v1
- Frontend tasks`,
  starIndentDrift: `* Observability
   * Structured logging with request IDs
  * Metrics exported to Prometheus
    * Alerting rules live in terraform/alerts.tf`,

  // nested-indent-off-by-one
  twoSpaceChildrenUnderOrdered: `1. Create a virtual environment
2. Install the requirements:
  - torch>=2.0
  - transformers>=4.40
3. Launch training with accelerate`,
  sevenSpaceChildren: `1. Install the CLI
2. Authenticate:
       - Run \`gcloud auth login\`
       - Select the project when prompted
3. Deploy with \`gcloud run deploy\``,
  widenedMarkerSameIndent: `9. Review the Grafana dashboards
10. Update the runbook:
  - Add the new alert thresholds
  - Link the postmortem template`,
  ambiguousYamlOverIndent: [
    '1. Add the job definition:',
    '',
    '       runs-on: ubuntu-latest',
    '       steps:',
    '         - uses: actions/checkout@v4',
    '       timeout-minutes: 10',
  ].join('\n'),

  // ordered-numbering-errors
  duplicateNumber: `1. Download the installer from the releases page
2. Run the setup wizard
2. Accept the license agreement
4. Choose the install directory`,
  allOnes: `1. Fork the repo
1. Create a feature branch
1. Commit with a signed-off message
1. Open a pull request`,
  zeroStart: `0. Prerequisites: Docker and make installed
1. Build the image
2. Run the container`,
  gapInSequence: `5. Verify the checksum
6. Extract the archive
8. Run ./configure`,

  // ordered-restart-midlist
  restartTopicShift: `1. Provision the RDS instance
2. Apply the schema migrations
3. Seed the reference tables
1. Point the staging environment at the new DB
2. Run the smoke tests`,
  restartProvenSlip: `1. Stop the ingest workers
2. Snapshot the queue
3. Deploy the new consumer
1. Restart the workers
5. Verify offsets match`,
  twoLabeledLists: `Setup:

1. Install terraform >= 1.7
2. Export AWS_PROFILE

Deployment:

1. terraform plan -out=tfplan
2. terraform apply tfplan`,

  // paren-and-alpha-ordered-markers
  parenNumbers: `(1) Tokenize the input with the byte-level BPE
(2) Normalize unicode to NFC
(3) Apply the merge table in rank order`,
  alphaMarkers: `a) Export DATABASE_URL and REDIS_URL
b) Source .envrc
c) Verify with \`env | grep -E 'DATABASE|REDIS'\``,
  dotParenMarkers: `1.) Back up the production database
2.) Run the migration inside a transaction
3.) Compare row counts before committing`,
  romanMarkers: `i. Freeze the model weights
ii. Train only the adapter layers
iii. Merge and re-quantize`,
  parenProseReference: `The optimizer has three constraints. (1) denotes the first constraint, and the rest of this section refers back to it by that number.`,

  // unicode-bullet-markers
  bulletDots: `• Reduced p99 latency from 480ms to 290ms
• Cut memory per worker roughly in half
• Removed the Redis dependency entirely`,
  enDashBullets: `– First pass: syntax normalization
– Second pass: reference resolution
– Third pass: dead-link pruning`,
  filledHollowCircles: `● Model architecture
  ○ 24 transformer layers, d_model 2048
  ○ Rotary position embeddings
● Training setup
  ○ 1.2T tokens, cosine schedule`,
  emDashBullets: `— We ship every Tuesday
— Rollbacks are one click in ArgoCD`,
  emDashContinuation: `The deploy pipeline runs on every merge to main
— and it usually finishes in well under nine minutes`,
  bulletGlyphInProse: `Use the • character when you need a literal bullet inside a sentence.`,

  // loose-tight-blank-line-drift
  strayBlankInTightList: `- Fast cold start (under 50ms)

- Small memory footprint
- No external dependencies
- Ships as a single static binary`,
  structuralContinuationBlank: `1. Run \`terraform plan\` and review every destroy.

   Pay special attention to anything in the rds module.

2. Apply during the change window.
3. Update the CMDB entry.`,
  doubleBlankTaskItems: `- [ ] Rotate the API keys


- [ ] Update the incident contact sheet`,
  genuinelyLooseList: `- First point, which stands on its own.

- Second point, also a complete thought.

- Third point, likewise.`,

  // under-indented-continuation
  underIndentedParagraphs: `1. Set the \`DATABASE_URL\` environment variable.

   You can find the connection string in the Render dashboard.

2. Run \`alembic upgrade head\`.

  This applies every migration that hasn't been recorded yet.

3. Restart the web service.`,
  underIndentedUnitFile: `2. Create the systemd unit at /etc/systemd/system/api.service:

  [Unit]
  Description=API server
  After=network.target`,
  lazyContinuation: `- The scheduler wakes every five minutes and samples queue depth.
If depth exceeds 1,000 it requests one more worker from the pool.`,

  // paragraph-after-list-same-indent
  orphanCommandSandwich: `1. Install poetry

pipx install poetry

2. Install the project dependencies

poetry install --with dev`,
  trailingCommentaryParagraph: `- Enable the flag in LaunchDarkly
- Roll out to 5% of traffic
- Watch error rates for 24 hours

Note that rollback is automatic if the error rate doubles within any 5-minute window.`,
  lazyContinuationBetweenSteps: `3. Configure DNS.
Add an A record pointing at the load balancer, then wait for propagation.
4. Request the TLS certificate.`,

  // task-list-marker-variants
  taskMarkerNearMisses: `- [x] Write unit tests for the retry logic
- [X] Update the changelog
- [] Deploy to staging
-[ ] Announce in #releases`,
  taskAsteriskAndTilde: `* [x] Migrate DNS to Route53
* [ ] Decommission the old load balancer
* [~] Update the architecture diagram (in progress)`,
  taskUnicodeMarks: `- [✓] Rotate the signing keys
- [✗] Enable audit logging (blocked on infra ticket)
- [ x] Bump the SDK version`,
  bracketCitations: `- [1] see the footnote at the bottom of the page
- [RFC 9110] defines the semantics we rely on`,
  validTaskList: `- [x] Ship the migration
- [ ] Delete the legacy table`,

  // pseudo-numbered-prose-steps
  stepProse: `Step 1: Clone the repository and cd into it.
Step 2: Copy .env.example to .env and fill in the Stripe keys.
Step 3: Run docker compose up and wait for the healthcheck.`,
  colonNumbers: `1: Pull the latest image
2: Restart the container
3: Tail the logs for thirty seconds`,
  boldPhaseParagraphs: `**Phase 1 — Discovery.** Inventory every service that still calls the v1 API.

**Phase 2 — Migration.** Move callers to v2 behind a feature flag.

**Phase 3 — Cleanup.** Delete the v1 handlers and their tests.`,
  singleStepMention: `Step 1: Clone the repository and cd into it.

The rest of the bootstrap is automated, so there is nothing else to run by hand.`,

  // deep-nesting-structure-loss
  siblingDemotedByDrift: `- Infrastructure
  - AWS
    - us-east-1 (prod cluster)
    - eu-west-1 (DR)
   - GCP
     - europe-west4 (batch jobs)
- Application`,
  staleDeepColumn: `1. Networking
   - VPC peering
   - Private DNS
     - Split-horizon zones
2. Storage
     - EBS snapshot policy
     - S3 lifecycle rules`,
  staleColumnOneLevelDown: `- Q3 goals
  - Reliability
    - SLO: 99.95% for the API
      - Error budget policy doc
  - Cost
      - Rightsize the staging cluster`,

  // misindented-code-fence-in-list
  fenceAtColumnZero: [
    '1. Build the image:',
    '```bash',
    'docker build -t api:latest .',
    '```',
    '2. Push it to the registry:',
    '```bash',
    'docker push registry.internal/api:latest',
    '```',
  ].join('\n'),
  fenceUnclosedBeforeSibling: [
    '- Run the deploy script:',
    '  ```sh',
    '  make deploy ENV=staging',
    '- Verify the health check returns 200',
  ].join('\n'),
  fenceOverIndented: [
    '2. Add this to the workflow file:',
    '',
    '        ```yaml',
    '        - uses: actions/checkout@v4',
    '        ```',
  ].join('\n'),
  markdownTutorialFence: [
    'Here is how you write the two list flavours:',
    '',
    '```markdown',
    '- First item',
    '- Second item',
    '',
    '1. Step one',
    '2. Step two',
    '```',
    '',
    'Those markers have to be typed literally.',
  ].join('\n'),

  // stray-space-marker-anomalies
  spaceBeforeDot: `1 . Download the quarterly export
2 . Shuffle and split 80/10/10
3 . Upload the splits to the bucket`,
  overIndentedSibling: `1. Preprocess the corpus
2. Train the tokenizer
    3. Evaluate compression on held-out text`,
  markerOnlyLine: `3.
Deploy the canary and watch the error-rate panel for ten minutes.`,
  escapedDotsAlone: `1\\. Install the toolchain
2\\. Run the bootstrap script`,
  escapedDotsInMarkdownDoc: `## Getting started

Follow the **exact** order below or the [bootstrap script](./bootstrap.sh) will fail.

1\\. Install the toolchain
2\\. Run the bootstrap script`,

  // missing-space-after-marker
  dashNoSpace: `-Update the API reference for the new endpoints
-Bump the version to 2.3.0 in pyproject.toml
-Tag the release and push the tag`,
  starNoSpace: `*Improved error messages for auth failures
*Fixed the pagination cursor off-by-one`,
  orderedNoSpace: `1.Install dependencies
2.Configure the webhook secret
3.Run the listener`,
  decimalNotAList: `Our new build is 1.5x faster than the previous release.`,
  negativeNumberLine: `-3 degrees was the coldest reading in the cold aisle last night.`,
  emphasisNotABullet: `*Improved error messages* shipped in release 2.3.0.`,

  // truncated-dangling-lists
  truncatedFinalSentence: `Rollout plan:

1. Enable dual-write behind the feature flag
2. Backfill the last 90 days of events
3. Compare row counts and checksums between the old and new`,
  danglingMarker: `- Pros:
  - Zero-downtime deploys
  - Built-in rollback
- Cons:
  -`,
  truncatedFence: [
    '3. Update the dashboard queries:',
    '   ```sql',
    '   SELECT service, p99_ms',
    '   FROM latency_rollup',
  ].join('\n'),

  // general guards
  wellFormedNested: `- Parent item
  - Child one
  - Child two
- Second parent`,
  wellFormedOrdered: `1. First
2. Second
3. Third`,
};

// ---------------------------------------------------------------------------
// Contract: never throws, always a document
// ---------------------------------------------------------------------------

describe('lists: parser contract', () => {
  it('returns a document (and renders) for every taxonomy input without throwing', () => {
    for (const [name, src] of Object.entries(EX)) {
      expect(() => parse(src), name).not.toThrow();
      const { ast } = parse(src);
      expect(ast.type, name).toBe('document');
      expect(Array.isArray(ast.children), name).toBe(true);
      expect(() => render(src), name).not.toThrow();
      const { html } = render(src);
      expect(typeof html, name).toBe('string');
    }
  });

  it('gives every list block a 1-based source position spanning its items', () => {
    const { ast } = parse(EX.wellFormedNested);
    const list = topLists(ast)[0]!;
    expect(list.pos.startLine).toBe(1);
    expect(list.pos.endLine).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mixed-indent-units
// ---------------------------------------------------------------------------

describe('lists: inconsistent indent widths', () => {
  it('keeps drifting 2/3/4-space children as one sub-list of the item above', () => {
    const { ast, diagnostics } = parse(EX.mixedIndentDrift);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);

    const nested = subList(lists[0]!.children[1]!);
    expect(nested).toBeDefined();
    expect(nested!.ordered).toBe(false);
    expect(nested!.children).toHaveLength(3);
    // the drift must not spawn extra nesting levels
    for (const item of nested!.children) expect(subList(item)).toBeUndefined();
    // and item 3 stays in the same ordered list
    expect(itemTexts(lists[0]!)[2]).toContain('Run the test suite');
    expect(codes(diagnostics)).toContain('list-indent-adjusted');
  });

  it('treats a tab-indented child and a 2-space child as the same depth', () => {
    const { ast } = parse(EX.tabAndSpaceChildren);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);

    const nested = subList(lists[0]!.children[0]!);
    expect(nested).toBeDefined();
    expect(nested!.children).toHaveLength(2);
    // no phantom third level created by the tab
    for (const item of nested!.children) expect(subList(item)).toBeUndefined();
    expect(itemTexts(nested!)[0]).toContain('Migrate the users table');
    expect(itemTexts(nested!)[1]).toContain('Add rate limiting');
  });

  it('snaps 3/2/4-space asterisk children to a single level under the parent', () => {
    const { ast } = parse(EX.starIndentDrift);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(1);

    const nested = subList(lists[0]!.children[0]!)!;
    expect(nested.children).toHaveLength(3);
    for (const item of nested.children) expect(subList(item)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// nested-indent-off-by-one
// ---------------------------------------------------------------------------

describe('lists: nested indent off by one', () => {
  it('nests 2-space bullets under the ordered item instead of ending the list', () => {
    const { ast } = parse(EX.twoSpaceChildrenUnderOrdered);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);

    const nested = subList(lists[0]!.children[1]!);
    expect(nested).toBeDefined();
    expect(itemTexts(nested!)).toEqual(['torch>=2.0', 'transformers>=4.40']);
  });

  it('reinterprets a 7-space marker run as a nested list, not indented code', () => {
    const { ast, diagnostics } = parse(EX.sevenSpaceChildren);
    expect(allBlocks(ast, 'codeBlock')).toHaveLength(0);

    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    const nested = subList(lists[0]!.children[1]!);
    expect(nested).toBeDefined();
    expect(nested!.children).toHaveLength(2);
    expect(itemTexts(nested!)[0]).toContain('gcloud auth login');
    expect(codes(diagnostics)).toContain('list-indent-adjusted');

    // and it must not render as monospaced literal dashes
    const { html } = render(EX.sevenSpaceChildren);
    expect(html).not.toContain('<pre>');
    expect(html).toContain('<ul>');
  });

  it('nests 2-space children under a widened "10." marker', () => {
    const { ast } = parse(EX.widenedMarkerSameIndent);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(9);
    expect(lists[0]!.children).toHaveLength(2);

    const nested = subList(lists[0]!.children[1]!);
    expect(nested).toBeDefined();
    expect(nested!.children).toHaveLength(2);
  });

  it('GUARD: keeps an over-indented YAML-shaped run as a code block, not a list', () => {
    const { ast } = parse(EX.ambiguousYamlOverIndent);
    const code = allBlocks(ast, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.value).toContain('runs-on: ubuntu-latest');
    expect(code[0]!.value).toContain('- uses: actions/checkout@v4');
  });
});

// ---------------------------------------------------------------------------
// ordered-numbering-errors
// ---------------------------------------------------------------------------

describe('lists: ordered numbering errors', () => {
  it('keeps 1,2,2,4 as one four-item list starting at 1', () => {
    const { ast, diagnostics } = parse(EX.duplicateNumber);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.start).toBe(1);
    expect(lists[0]!.children).toHaveLength(4);
    expect(codes(diagnostics)).toContain('list-nonsequential-numbers');

    const { html } = render(EX.duplicateNumber);
    expect((html.match(/<ol/g) ?? []).length).toBe(1);
    expect((html.match(/<li/g) ?? []).length).toBe(4);
  });

  it('GUARD: treats the all-1s convention as style, never as an error to repair', () => {
    const { ast, diagnostics } = parse(EX.allOnes);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(1);
    expect(lists[0]!.children).toHaveLength(4);
    for (const d of diagnostics) expect(d.severity).toBe('note');
  });

  it('preserves a deliberate start=0 instead of renumbering to 1', () => {
    const { ast, html } = { ...parse(EX.zeroStart), ...render(EX.zeroStart) };
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(0);
    expect(lists[0]!.children).toHaveLength(3);
    expect(html).toContain('start="0"');
  });

  it('keeps a deliberate start=5 while absorbing the 6 -> 8 gap into one list', () => {
    const { ast, diagnostics } = parse(EX.gapInSequence);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(5);
    expect(lists[0]!.children).toHaveLength(3);
    expect(codes(diagnostics)).toContain('list-nonsequential-numbers');
  });

  it('GUARD: a well-formed 1,2,3 list needs no repairs at all', () => {
    const { ast, diagnostics } = parse(EX.wellFormedOrdered);
    expect(codes(diagnostics)).toEqual([]);
    expect(topLists(ast)[0]!.children).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// ordered-restart-midlist
// ---------------------------------------------------------------------------

describe('lists: numbering restarts mid-list', () => {
  it('splits into two phase lists when the restart increments cleanly from 1', () => {
    const { ast } = parse(EX.restartTopicShift);
    const lists = topLists(ast);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.children).toHaveLength(3);
    expect(lists[1]!.children).toHaveLength(2);
    expect(lists[1]!.start).toBe(1);
    expect(itemTexts(lists[1]!)[0]).toContain('Point the staging environment');
    // the decision must be recorded so a consumer can flip the interpretation
    const { diagnostics } = parse(EX.restartTopicShift);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('keeps one list when a later number resumes the pre-restart sequence', () => {
    const { ast } = parse(EX.restartProvenSlip);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(5);
    expect(itemTexts(lists[0]!)[4]).toContain('Verify offsets match');
  });

  it('GUARD: never merges two lists separated by a labeling paragraph', () => {
    const { ast, diagnostics } = parse(EX.twoLabeledLists);
    const lists = topLists(ast);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.children).toHaveLength(2);
    expect(lists[1]!.children).toHaveLength(2);
    expect(lists[1]!.start).toBe(1);
    expect(listRepairs(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// paren-and-alpha-ordered-markers
// ---------------------------------------------------------------------------

describe('lists: paren, alpha and roman ordered markers', () => {
  it('promotes (1)/(2)/(3) lines to an ordered list rather than one paragraph', () => {
    const { ast, diagnostics } = parse(EX.parenNumbers);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.start).toBe(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[0]).toContain('Tokenize the input');
    expect(codes(diagnostics)).toContain('list-paren-number');
  });

  it('promotes a lettered a)/b)/c) run to an ordered list and strips the markers', () => {
    const { ast } = parse(EX.alphaMarkers);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[0]!.startsWith('Export DATABASE_URL')).toBe(true);
    expect(itemTexts(lists[0]!)[1]).toContain('Source .envrc');
  });

  it('consumes the whole "1.)" marker so no stray paren leads the item text', () => {
    const { ast } = parse(EX.dotParenMarkers);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    const first = itemTexts(lists[0]!)[0]!;
    expect(first.startsWith(')')).toBe(false);
    expect(first).toContain('Back up the production database');
  });

  it('reads i./ii./iii. as a roman ordered list, not prose', () => {
    const { ast } = parse(EX.romanMarkers);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[1]).toContain('Train only the adapter layers');
  });

  it('GUARD: a lone "(1) denotes ..." prose reference stays a paragraph', () => {
    const { ast, diagnostics } = parse(EX.parenProseReference);
    expect(allLists(ast)).toHaveLength(0);
    expect(ast.children[0]!.type).toBe('paragraph');
    expect(listRepairs(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unicode-bullet-markers
// ---------------------------------------------------------------------------

describe('lists: unicode bullet glyphs', () => {
  it('promotes a run of U+2022 bullets to a real list', () => {
    const { ast, diagnostics } = parse(EX.bulletDots);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(false);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[0]).toContain('Reduced p99 latency');
    expect(codes(diagnostics)).toContain('list-unicode-bullet');

    // the glyph itself is consumed as the marker, not kept in the text
    const { html } = render(EX.bulletDots);
    expect(html).toContain('<ul>');
    expect(html).not.toContain('•');
  });

  it('promotes en-dash bullets to a three-item list', () => {
    const { ast } = parse(EX.enDashBullets);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[2]).toContain('Third pass: dead-link pruning');
  });

  it('uses indentation to build the two levels of a filled/hollow circle list', () => {
    const { ast } = parse(EX.filledHollowCircles);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);
    expect(subList(lists[0]!.children[0]!)!.children).toHaveLength(2);
    expect(subList(lists[0]!.children[1]!)!.children).toHaveLength(1);
  });

  it('promotes em-dash bullets when both lines start capitalized statements', () => {
    const { ast } = parse(EX.emDashBullets);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);
    expect(itemTexts(lists[0]!)[0]).toContain('We ship every Tuesday');
  });

  it('GUARD: a lowercase em-dash line after an unpunctuated line stays prose', () => {
    const { ast, diagnostics } = parse(EX.emDashContinuation);
    expect(allLists(ast)).toHaveLength(0);
    expect(listRepairs(diagnostics)).toEqual([]);
  });

  it('GUARD: a bullet glyph inside a sentence never becomes a list', () => {
    const { ast } = parse(EX.bulletGlyphInProse);
    expect(allLists(ast)).toHaveLength(0);
    expect(textOf(ast)).toContain('•');
  });
});

// ---------------------------------------------------------------------------
// loose-tight-blank-line-drift
// ---------------------------------------------------------------------------

describe('lists: loose/tight blank-line drift', () => {
  it('ignores one stray blank line and keeps the four-item list tight', () => {
    const { ast } = parse(EX.strayBlankInTightList);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(4);
    expect(lists[0]!.tight).toBe(true);

    // no <p> wrappers, i.e. the list is not visually double-spaced
    const { html } = render(EX.strayBlankInTightList);
    expect(html).toContain('<li>Fast cold start (under 50ms)</li>');
  });

  it('keeps a structural continuation paragraph inside item 1 without splitting', () => {
    const { ast } = parse(EX.structuralContinuationBlank);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);

    const first = lists[0]!.children[0]!;
    expect(first.children.filter((c) => c.type === 'paragraph')).toHaveLength(2);
    expect(textOf(first)).toContain('Pay special attention to anything in the rds module');
    expect(itemTexts(lists[0]!)[1]).toContain('Apply during the change window');
  });

  it('keeps two task items separated by a double blank in one list', () => {
    const { ast } = parse(EX.doubleBlankTaskItems);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);
    expect(lists[0]!.children.map((i) => i.checked)).toEqual([false, false]);
  });

  it('GUARD: a deliberately loose list stays loose and is not tightened', () => {
    const { ast, diagnostics } = parse(EX.genuinelyLooseList);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(lists[0]!.tight).toBe(false);
    expect(listRepairs(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// under-indented-continuation
// ---------------------------------------------------------------------------

describe('lists: under-indented continuations', () => {
  it('attaches a 2-space continuation paragraph to the item above it', () => {
    const { ast } = parse(EX.underIndentedParagraphs);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(textOf(lists[0]!.children[1]!)).toContain(
      "This applies every migration that hasn't been recorded yet",
    );
    // and nothing is orphaned at top level
    expect(ast.children.filter((b) => b.type === 'paragraph')).toHaveLength(0);
    expect(ast.children.filter((b) => b.type === 'list')).toHaveLength(1);
  });

  it('turns an under-indented INI-shaped block into a code block inside the item', () => {
    const { ast } = parse(EX.underIndentedUnitFile);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(2);
    expect(lists[0]!.children).toHaveLength(1);

    const code = allBlocks(lists[0]!.children[0]!, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.value).toContain('[Unit]');
    expect(code[0]!.value).toContain('Description=API server');
  });

  it('GUARD: a legal lazy continuation is one item and needs no repair', () => {
    const { ast, diagnostics } = parse(EX.lazyContinuation);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(1);
    const text = textOf(lists[0]!.children[0]!);
    expect(text).toContain('samples queue depth');
    expect(text).toContain('requests one more worker');
    expect(codes(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// paragraph-after-list-same-indent
// ---------------------------------------------------------------------------

describe('lists: flush-left blocks around a list', () => {
  it('attaches a sandwiched flush-left command to the step above it', () => {
    const { ast } = parse(EX.orphanCommandSandwich);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);
    expect(textOf(lists[0]!.children[0]!)).toContain('pipx install poetry');
    expect(textOf(lists[0]!.children[1]!)).toContain('poetry install --with dev');
  });

  it('renders sandwiched command orphans as code, not prose', () => {
    const { ast } = parse(EX.orphanCommandSandwich);
    const code = allBlocks(ast, 'codeBlock');
    expect(code.length).toBeGreaterThanOrEqual(1);
    expect(code.map((c) => c.value).join('\n')).toContain('pipx install poetry');
  });

  it('GUARD: trailing commentary after the last item stays a sibling paragraph', () => {
    const { ast } = parse(EX.trailingCommentaryParagraph);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(textOf(lists[0]!.children[2]!)).not.toContain('Note that rollback');

    const last = ast.children[ast.children.length - 1]!;
    expect(last.type).toBe('paragraph');
    expect(textOf(last)).toContain('Note that rollback is automatic');
  });

  it('GUARD: a lazy continuation between two numbered steps needs no repair', () => {
    const { ast, diagnostics } = parse(EX.lazyContinuationBetweenSteps);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(3);
    expect(lists[0]!.children).toHaveLength(2);
    expect(textOf(lists[0]!.children[0]!)).toContain('Add an A record pointing at the load balancer');
    expect(codes(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// task-list-marker-variants
// ---------------------------------------------------------------------------

describe('lists: task marker variants', () => {
  it('reads [x], [X], [] and -[ ] as four task items in one list', () => {
    const { ast, diagnostics } = parse(EX.taskMarkerNearMisses);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(4);
    expect(lists[0]!.children.map((i) => i.checked)).toEqual([true, true, false, false]);
    expect(codes(diagnostics)).toContain('task-marker-nonstandard');

    // the brackets are consumed, not left as literal text
    const texts = itemTexts(lists[0]!);
    expect(texts[2]).toBe('Deploy to staging');
    expect(texts[3]).toBe('Announce in #releases');

    const { html } = render(EX.taskMarkerNearMisses);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(4);
  });

  it('handles asterisk task markers and treats [~] as not-yet-done', () => {
    const { ast } = parse(EX.taskAsteriskAndTilde);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(lists[0]!.children.map((i) => i.checked)).toEqual([true, false, false]);
    expect(itemTexts(lists[0]!)[2]).toContain('Update the architecture diagram');
  });

  it('maps unicode check marks and a stray inner space to the right states', () => {
    const { ast } = parse(EX.taskUnicodeMarks);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(lists[0]!.children.map((i) => i.checked)).toEqual([true, false, true]);
    expect(itemTexts(lists[0]!)[1]).toContain('Enable audit logging');
  });

  it('GUARD: bracketed citations are plain list items, not task checkboxes', () => {
    const { ast, diagnostics } = parse(EX.bracketCitations);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children.map((i) => i.checked)).toEqual([null, null]);
    expect(itemTexts(lists[0]!)[0]).toContain('[1]');
    expect(itemTexts(lists[0]!)[1]).toContain('[RFC 9110]');
    expect(codes(diagnostics)).not.toContain('task-marker-nonstandard');
  });

  it('GUARD: a well-formed GFM task list is parsed with no repairs', () => {
    const { ast, diagnostics } = parse(EX.validTaskList);
    expect(topLists(ast)[0]!.children.map((i) => i.checked)).toEqual([true, false]);
    expect(codes(diagnostics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pseudo-numbered-prose-steps
// ---------------------------------------------------------------------------

describe('lists: prose step labels', () => {
  it('splits "Step 1/2/3" lines into three items instead of one run-on paragraph', () => {
    const { ast } = parse(EX.stepProse);
    const lists = allLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);

    // the "Step N" labels survive so cross-references still resolve
    const texts = itemTexts(lists[0]!);
    expect(texts[0]).toContain('Step 1');
    expect(texts[1]).toContain('Step 2');
    expect(texts[2]).toContain('Step 3');
    expect(texts[1]).toContain('Copy .env.example to .env');
  });

  it('promotes "1:" colon markers to an ordered list', () => {
    const { ast } = parse(EX.colonNumbers);
    const lists = allLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[2]).toContain('Tail the logs');
  });

  it('keeps three bold-labelled phases as three separate blocks', () => {
    const { html } = render(EX.boldPhaseParagraphs);
    expect((html.match(/<strong>/g) ?? []).length).toBe(3);
    expect((html.match(/<p>|<li>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('Phase 2');
  });

  it('GUARD: a single "Step 1:" line with no sibling step stays a paragraph', () => {
    const { ast } = parse(EX.singleStepMention);
    expect(allLists(ast)).toHaveLength(0);
    expect(ast.children[0]!.type).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// deep-nesting-structure-loss
// ---------------------------------------------------------------------------

describe('lists: deep nesting drift', () => {
  it('keeps GCP a sibling of AWS despite the 3-space drift', () => {
    const { ast } = parse(EX.siblingDemotedByDrift);
    const outer = topLists(ast)[0]!;
    expect(outer.children).toHaveLength(2);

    const level2 = subList(outer.children[0]!)!;
    expect(level2.children).toHaveLength(2);
    expect(itemTexts(level2)[0]).toContain('AWS');
    expect(itemTexts(level2)[1]).toContain('GCP');
    expect(subList(level2.children[0]!)!.children).toHaveLength(2);
    expect(subList(level2.children[1]!)!.children).toHaveLength(1);
  });

  it('resets the indent ladder at a new top-level item instead of reusing a stale column', () => {
    const { ast } = parse(EX.staleDeepColumn);
    const outer = topLists(ast)[0]!;
    expect(outer.children).toHaveLength(2);

    const storageChildren = subList(outer.children[1]!);
    expect(storageChildren).toBeDefined();
    expect(storageChildren!.children).toHaveLength(2);
    for (const item of storageChildren!.children) expect(subList(item)).toBeUndefined();
    expect(itemTexts(storageChildren!)[0]).toContain('EBS snapshot policy');
  });

  it('snaps a stale deep column back to a direct child one level down', () => {
    const { ast } = parse(EX.staleColumnOneLevelDown);
    const goals = subList(topLists(ast)[0]!.children[0]!)!;
    expect(itemTexts(goals)[0]).toContain('Reliability');
    expect(itemTexts(goals)[1]).toContain('Cost');

    const costChildren = subList(goals.children[1]!);
    expect(costChildren).toBeDefined();
    expect(costChildren!.children).toHaveLength(1);
    expect(subList(costChildren!.children[0]!)).toBeUndefined();
    expect(itemTexts(costChildren!)[0]).toContain('Rightsize the staging cluster');
  });
});

// ---------------------------------------------------------------------------
// misindented-code-fence-in-list
// ---------------------------------------------------------------------------

describe('lists: misindented code fences', () => {
  it('adopts column-0 fences into the steps they belong to', () => {
    const { ast } = parse(EX.fenceAtColumnZero);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);

    const first = allBlocks(lists[0]!.children[0]!, 'codeBlock');
    const second = allBlocks(lists[0]!.children[1]!, 'codeBlock');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.lang).toBe('bash');
    expect(first[0]!.value).toContain('docker build -t api:latest .');
    expect(second[0]!.value).toContain('docker push registry.internal/api:latest');

    // numbering stays continuous — one <ol>, no restart at 1
    const { html } = render(EX.fenceAtColumnZero);
    expect((html.match(/<ol/g) ?? []).length).toBe(1);
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  it('auto-closes an unclosed fence before the next sibling bullet', () => {
    const { ast, diagnostics } = parse(EX.fenceUnclosedBeforeSibling);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);

    const code = allBlocks(lists[0]!.children[0]!, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.value).toContain('make deploy ENV=staging');
    expect(code[0]!.value).not.toContain('Verify the health check');
    expect(itemTexts(lists[0]!)[1]).toContain('Verify the health check returns 200');
    expect(codes(diagnostics)).toContain('fence-unclosed');
  });

  it('unwraps an over-indented fence instead of double-wrapping the backticks', () => {
    const { ast } = parse(EX.fenceOverIndented);
    const code = allBlocks(ast, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.lang).toBe('yaml');
    expect(code[0]!.value).toContain('- uses: actions/checkout@v4');
    expect(code[0]!.value).not.toContain('```');

    // and it stays inside the item it documents
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(allBlocks(lists[0]!, 'codeBlock')).toHaveLength(1);
  });

  it('GUARD: literal list syntax inside a markdown tutorial fence stays code', () => {
    const { ast } = parse(EX.markdownTutorialFence);
    expect(allLists(ast)).toHaveLength(0);
    const code = allBlocks(ast, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.value).toContain('- First item');
    expect(code[0]!.value).toContain('1. Step one');
  });
});

// ---------------------------------------------------------------------------
// stray-space-marker-anomalies
// ---------------------------------------------------------------------------

describe('lists: stray-space and degenerate markers', () => {
  it('tolerates "1 ." markers when the run is sequential', () => {
    const { ast } = parse(EX.spaceBeforeDot);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[0]).toBe('Download the quarterly export');
  });

  it('treats an over-indented "3." continuing the outer count as a sibling', () => {
    const { ast } = parse(EX.overIndentedSibling);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    for (const item of lists[0]!.children) expect(subList(item)).toBeUndefined();
    expect(itemTexts(lists[0]!)[2]).toContain('Evaluate compression on held-out text');
  });

  it('joins a marker-only line with the text on the following line', () => {
    const { ast } = parse(EX.markerOnlyLine);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(3);
    expect(lists[0]!.children).toHaveLength(1);
    expect(textOf(lists[0]!.children[0]!)).toContain('Deploy the canary');
    expect(ast.children.filter((b) => b.type === 'paragraph')).toHaveLength(0);
  });

  it('GUARD: escaped "1\\." lines in a literal-looking document stay text', () => {
    const { ast, html } = { ...parse(EX.escapedDotsAlone), ...render(EX.escapedDotsAlone) };
    expect(allLists(ast)).toHaveLength(0);
    expect(html).toContain('1. Install the toolchain');
  });

  it('promotes escaped "1\\." markers inside an otherwise rich markdown document', () => {
    const { ast, diagnostics } = parse(EX.escapedDotsInMarkdownDoc);
    const lists = allLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(2);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// missing-space-after-marker
// ---------------------------------------------------------------------------

describe('lists: missing space after the marker', () => {
  it('promotes a run of "-Text" lines to a three-item bullet list', () => {
    const { ast } = parse(EX.dashNoSpace);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[0]).toBe('Update the API reference for the new endpoints');
  });

  it('reads "*Text" lines with no closing star as bullets, not emphasis', () => {
    const { ast, html } = { ...parse(EX.starNoSpace), ...render(EX.starNoSpace) };
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(2);
    expect(html).not.toContain('<em>');
    expect(itemTexts(lists[0]!)[1]).toBe('Fixed the pagination cursor off-by-one');
  });

  it('promotes "1.Install" style ordered runs', () => {
    const { ast } = parse(EX.orderedNoSpace);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.ordered).toBe(true);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[1]).toBe('Configure the webhook secret');
  });

  it('GUARD: a decimal like "1.5x faster" never becomes a list', () => {
    const { ast } = parse(EX.decimalNotAList);
    expect(allLists(ast)).toHaveLength(0);
    expect(ast.children[0]!.type).toBe('paragraph');
  });

  it('GUARD: a line opening with a negative number is not a bullet', () => {
    const { ast } = parse(EX.negativeNumberLine);
    expect(allLists(ast)).toHaveLength(0);
    expect(textOf(ast)).toContain('-3 degrees');
  });

  it('GUARD: a closed *emphasis* opening a line is emphasis, not a bullet', () => {
    const { ast, html } = { ...parse(EX.emphasisNotABullet), ...render(EX.emphasisNotABullet) };
    expect(allLists(ast)).toHaveLength(0);
    expect(html).toContain('<em>Improved error messages</em>');
  });
});

// ---------------------------------------------------------------------------
// truncated-dangling-lists
// ---------------------------------------------------------------------------

describe('lists: truncated output', () => {
  it('keeps a mid-sentence truncated final item intact in the list', () => {
    const { ast } = parse(EX.truncatedFinalSentence);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.children).toHaveLength(3);
    expect(itemTexts(lists[0]!)[2]).toContain('Compare row counts and checksums');
    expect(ast.children[0]!.type).toBe('paragraph');
  });

  it('drops a dangling empty marker at EOF instead of rendering an empty bullet', () => {
    const { ast, html } = { ...parse(EX.danglingMarker), ...render(EX.danglingMarker) };
    const outer = topLists(ast)[0]!;
    expect(outer.children).toHaveLength(2);
    expect(html).not.toMatch(/<li>\s*<\/li>/);
    const cons = outer.children[1]!;
    const consSub = subList(cons);
    if (consSub) expect(consSub.children).toHaveLength(0);

    // the completed part of the list is untouched
    const pros = subList(outer.children[0]!)!;
    expect(pros.children).toHaveLength(2);
    expect(itemTexts(pros)).toEqual(['Zero-downtime deploys', 'Built-in rollback']);
  });

  it('auto-closes a fence truncated at EOF and flags it', () => {
    const { ast, diagnostics } = parse(EX.truncatedFence);
    const lists = topLists(ast);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.start).toBe(3);
    expect(lists[0]!.children).toHaveLength(1);

    const code = allBlocks(lists[0]!, 'codeBlock');
    expect(code).toHaveLength(1);
    expect(code[0]!.autoClosed).toBe(true);
    expect(code[0]!.lang).toBe('sql');
    expect(code[0]!.value).toContain('SELECT service, p99_ms');
    expect(codes(diagnostics)).toContain('fence-unclosed');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting guards
// ---------------------------------------------------------------------------

describe('lists: guards on well-formed input', () => {
  it('GUARD: a standard 2-space nested list parses with zero diagnostics', () => {
    const { ast, diagnostics } = parse(EX.wellFormedNested);
    expect(codes(diagnostics)).toEqual([]);
    const outer = topLists(ast)[0]!;
    expect(outer.children).toHaveLength(2);
    expect(subList(outer.children[0]!)!.children).toHaveLength(2);
    expect(subList(outer.children[1]!)).toBeUndefined();

    const { html } = render(EX.wellFormedNested);
    expect(html).toContain('<ul>');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('start=');
  });
});
