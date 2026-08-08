import { describe, it, expect } from 'vitest';
import { parse, render } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk every node in the tree (blocks, table rows/cells, inlines). */
function walk(node: any, visit: (n: any) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of ['children', 'rows', 'cells']) {
    if (Array.isArray(node[key])) walk(node[key], visit);
  }
}

function nodesOfType(root: any, type: string): any[] {
  const out: any[] = [];
  walk(root, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
}

/** Concatenated visible text of an inline node array. */
function inlineText(nodes: any[]): string {
  let out = '';
  walk(nodes, (n) => {
    if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') out += n.value;
    else if (n.type === 'image') out += n.alt;
  });
  return out;
}

/** Visible text of rendered HTML: tags stripped, basic entities decoded. */
function visible(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function codes(diagnostics: any[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** Every literal example input from the taxonomy, for the never-throws contract. */
const TAXONOMY_INPUTS: string[] = [
  '- **Latency: p99 dropped from 480ms to 210ms after enabling connection pooling.\n- **Throughput:** improved 2.1x under the same load profile.',
  'The results were **statistically significant (p < 0.01) and held across every cohort we tested.\nWe therefore recommend shipping the new ranking model.',
  'In summary, the migration is low-risk because **the schema change is backwards compatible',
  'This is **very *important** to remember* when configuring retries.',
  '__Critical: **do not rotate the signing key__ during deploys**.',
  '*The default is **eventual consistency*, not strong consistency**.',
  '** Warning ** this endpoint is rate-limited to 60 requests per minute.',
  'The flag `--dry-run` is **only respected in CI ** and ignored locally.',
  '*  primary region: us-east-1  *',
  'This change is ***breaking** and requires a major version bump.',
  '**Do not** commit secrets to the repo — ***ever*.',
  'The fix is simple: ***always*** ***pin your dependency versions**.',
  'Run `npm install --save-dev typescript and then add a tsconfig.json to the project root.',
  'Set `DATABASE_URL to the connection string from the dashboard.',
  'The error comes from `src/handlers/auth.py:142',
  'Use the `--format=`json`` flag to get machine-readable output.',
  'In markdown, wrap commands like `ls -la` in backticks: `like `this``.',
  'Run `echo `date`` to print the current time.',
  'See [the deployment guide] (https://docs.internal.corp/deploy/v2) before touching prod.',
  'Details are in [the RFC(https://internal.corp/rfc/0042-schema-migration).',
  'Check the (changelog)[https://github.com/acme/api/releases] for breaking changes.',
  'Full context in [this thread]https://slack.com/archives/C024BE91L/p1701234567',
  'Download the deck from [Q3 review](https://drive.google.com/file/Q3 Planning Final v2.pdf) and skim slides 4-9.',
  'See [Recursion](https://en.wikipedia.org/wiki/Recursion_(computer_science) for the formal definition.',
  'The incident timeline is at [the postmortem](https://wiki.corp.example.com/display/SRE/2026-07-14+API+Gateway+Outage',
  'Track progress in https://github.com/acme/gateway/issues/1287, and ping me if it stalls.',
  'The dashboard lives at https://grafana.corp.example.com/d/api_latency_p99/overview (staging uses grafana-stg).',
  'More examples at www.commonmark.org/help and in the spec.',
  'This mirrors the approach in [the Raft paper][1] and the [etcd implementation][2].\n\n[1]: https://raft.github.io/raft.pdf',
  'As described in [Kleppmann 2017], log compaction bounds storage growth.',
  'See the [official docs][docs] for the full flag list.',
  '! [Architecture diagram](https://raw.githubusercontent.com/acme/gateway/main/docs/arch.png)',
  '![Latency histogram after the fix]sandbox:/mnt/data/latency_hist.png',
  '[!NOTE] The cache is invalidated on every deploy.',
  String.raw`Logs are written to C:\Users\svc_gateway\AppData\Local\Temp\gw.log on Windows hosts.`,
  String.raw`Rename the field to user\_id and drop the legacy \_v1 suffix from all payloads.`,
  String.raw`Multiply by the weight \\* attention mask before the softmax.`,
  String.raw`The loss is $L = \sum_i (y_i - \hat{y}_i)^2$ averaged over the batch, so $x_i$ and $y_j$ share the index set.`,
  'Revenue grew from $3M to $4.2M, driven by the $enterprise$ tier.',
  String.raw`where \( \alpha = 0.9 \) controls momentum and the update is \[ w_{t+1} = w_t - \eta \nabla L \] applied per step.`,
  String.raw`The bound is $$\mathbb{E}[X] \le \sqrt{2\sigma^2 \log n}$ for sub-Gaussian noise.`,
  'Set the header to <b>application/json</b> or the request will be rejected.<br>Retry with backoff on 429.',
  'Paste your token where it says <YOUR_API_KEY> in the config below.',
  'The handler returns a Promise<Map<string, number>> so callers must await it.',
  '<div class="warning">\nDo not run this against production. The script issues DELETEs without a dry-run flag.',
  '~~Deprecated: use /v1/users~~ Use /v2/accounts instead. Response time is ~200ms at p50.',
  'The old flag ~~--legacy-auth~ was removed in 3.0.',
  'Config lives in ~/.gateway/config.toml and secrets in ~/.gateway/secrets/.',
  '**\u201CDo not merge\u201D** was the review verdict, but CI had already deployed\u2026',
  'The rollout is **\u00A0blocked\u00A0** until legal signs off.',
  'Set the env var to \u201Cproduction\u201D exactly: `NODE_ENV=\u201Cproduction\u201D` will not match the string check.',
  '**\u200BImportant\u200B** \u2014 schema migrations now run in a separate job.',
];

// ---------------------------------------------------------------------------
// Contract: never throws
// ---------------------------------------------------------------------------

describe('inline parsing: never-throws contract', () => {
  it('returns a document (and never throws) for every taxonomy example input', () => {
    for (const src of TAXONOMY_INPUTS) {
      let result: any;
      expect(() => {
        result = parse(src);
      }, `parse threw on: ${JSON.stringify(src.slice(0, 60))}`).not.toThrow();
      expect(result.ast.type).toBe('document');
      expect(Array.isArray(result.ast.children)).toBe(true);
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(() => render(src)).not.toThrow();
    }
  });

  it('returns a document for empty and whitespace-only input', () => {
    for (const src of ['', '   ', '\n\n', '\t']) {
      const { ast, diagnostics } = parse(src);
      expect(ast.type).toBe('document');
      expect(Array.isArray(diagnostics)).toBe(true);
    }
  });

  it('survives pathological delimiter soup without hanging or throwing', () => {
    const soup = '***__~~`[![(' + '*_~`'.repeat(200) + '](';
    const { ast } = parse(soup);
    expect(ast.type).toBe('document');
    expect(() => render(soup)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1. Unclosed strong/emphasis delimiters
// ---------------------------------------------------------------------------

describe('unclosed strong/emphasis: opened and never closed', () => {
  it('closes an unclosed bold label right after its colon, matching the sibling bullet', () => {
    const { html, diagnostics } = render(`- **Latency: p99 dropped from 480ms to 210ms after enabling connection pooling.
- **Throughput:** improved 2.1x under the same load profile.`);
    expect(html).toContain('<strong>Latency:</strong>');
    expect(html).toContain('<strong>Throughput:</strong>');
    expect(visible(html)).toContain('p99 dropped from 480ms to 210ms');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });

  it('never lets an unclosed bold span spill onto the following line', () => {
    const { html, diagnostics } = render(`The results were **statistically significant (p < 0.01) and held across every cohort we tested.
We therefore recommend shipping the new ranking model.`);
    const { ast } = parse(`The results were **statistically significant (p < 0.01) and held across every cohort we tested.
We therefore recommend shipping the new ranking model.`);
    const strongs = nodesOfType(ast, 'strong');
    expect(strongs).toHaveLength(1);
    expect(inlineText(strongs[0].children)).toContain('statistically significant');
    expect(inlineText(strongs[0].children)).not.toContain('We therefore recommend');
    expect(visible(html)).toContain('We therefore recommend shipping the new ranking model.');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });

  it('bolds to end of input when the generation was truncated mid-bold', () => {
    const { html, diagnostics } = render(
      'In summary, the migration is low-risk because **the schema change is backwards compatible',
    );
    expect(html).toContain('<strong>the schema change is backwards compatible</strong>');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });

  it('auto-closes an unclosed __ run at end of line without leaking underscores', () => {
    const { html, diagnostics } = render('Remember: __never log the raw token in production handlers.');
    expect(html).toContain('<strong>never log the raw token in production handlers.</strong>');
    expect(visible(html)).not.toContain('_');
    expect(codes(diagnostics)).toContain('emphasis-auto-closed');
  });
});

// ---------------------------------------------------------------------------
// 2. Mismatched / interleaved bold+italic nesting
// ---------------------------------------------------------------------------

describe('mismatched and interleaved bold/italic nesting', () => {
  it('resolves overlapping **A *B** C* into properly nested spans with no literal asterisks left', () => {
    const src = 'This is **very *important** to remember* when configuring retries.';
    const { html } = render(src);
    expect(visible(html)).toBe('This is very important to remember when configuring retries.');
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>');
  });

  it('merges doubled-up __ and ** conventions into a single strong span', () => {
    const src = '__Critical: **do not rotate the signing key__ during deploys**.';
    const { html } = render(src);
    const { ast } = parse(src);
    expect(visible(html)).toBe('Critical: do not rotate the signing key during deploys.');
    const strongs = nodesOfType(ast, 'strong');
    expect(strongs.length).toBeGreaterThan(0);
    expect(strongs.some((s) => inlineText(s.children).includes('do not rotate the signing key'))).toBe(true);
  });

  it('splits crossing em/strong ranges instead of leaving stray delimiters', () => {
    const src = '*The default is **eventual consistency*, not strong consistency**.';
    const { html } = render(src);
    expect(visible(html)).toBe('The default is eventual consistency, not strong consistency.');
    expect(html).toContain('<em>');
    expect(html).toContain('<strong>');
  });
});

// ---------------------------------------------------------------------------
// 3. Space-padded emphasis
// ---------------------------------------------------------------------------

describe('space-padded emphasis delimiters', () => {
  it('bolds "Warning" when both sides of the ** are padded with spaces', () => {
    const { html, diagnostics } = render('** Warning ** this endpoint is rate-limited to 60 requests per minute.');
    expect(html).toContain('<strong>Warning</strong>');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('emphasis-space-padded');
  });

  it('relaxes only the failing side for one-sided padding before the closer', () => {
    const { html, diagnostics } = render('The flag `--dry-run` is **only respected in CI ** and ignored locally.');
    expect(html).toContain('<code>--dry-run</code>');
    expect(html).toContain('<strong>only respected in CI</strong>');
    expect(visible(html)).toContain('and ignored locally.');
    expect(visible(html)).not.toContain('*');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('does not leave a dangling asterisk when a padded emphasis spans a whole line', () => {
    const { html } = render('*  primary region: us-east-1  *');
    expect(visible(html)).toContain('primary region: us-east-1');
    expect(visible(html)).not.toContain('*');
  });
});

// ---------------------------------------------------------------------------
// 4. Triple-asterisk / mixed-strength confusion
// ---------------------------------------------------------------------------

describe('triple-asterisk and mixed-strength delimiter confusion', () => {
  it('does not let the orphan * from ***text** open emphasis over the rest of the sentence', () => {
    const src = 'This change is ***breaking** and requires a major version bump.';
    const { html } = render(src);
    const { ast } = parse(src);
    expect(html).toContain('breaking</strong>');
    expect(visible(html)).toBe('This change is breaking and requires a major version bump.');
    const emphs = nodesOfType(ast, 'emphasis');
    expect(emphs.every((e) => !inlineText(e.children).includes('major version bump'))).toBe(true);
  });

  it('bounds ***ever* to just the word before the punctuation', () => {
    const src = '**Do not** commit secrets to the repo — ***ever*.';
    const { html } = render(src);
    const { ast } = parse(src);
    expect(html).toContain('<strong>Do not</strong>');
    expect(visible(html)).toBe('Do not commit secrets to the repo — ever.');
    const marked = [...nodesOfType(ast, 'emphasis'), ...nodesOfType(ast, 'strong')];
    expect(marked.some((n) => inlineText(n.children) === 'ever')).toBe(true);
  });

  it('uses a well-formed ***x*** in the same block as the template for a ***y** run', () => {
    const src = 'The fix is simple: ***always*** ***pin your dependency versions**.';
    const { html } = render(src);
    expect(html).toContain('<em><strong>always</strong></em>');
    expect(html).toContain('pin your dependency versions</strong>');
    expect(visible(html)).toBe('The fix is simple: always pin your dependency versions.');
  });

  it('drops the trailing junk asterisk of **text*** instead of rendering it', () => {
    const { html } = render('Use the **canonical form*** for all new configs.');
    expect(html).toContain('canonical form</strong>');
    expect(visible(html)).toBe('Use the canonical form for all new configs.');
  });
});

// ---------------------------------------------------------------------------
// 5. Unclosed inline code
// ---------------------------------------------------------------------------

describe('unclosed inline-code backtick', () => {
  it('closes the code span at the code/prose boundary, not at end of line', () => {
    const src = 'Run `npm install --save-dev typescript and then add a tsconfig.json to the project root.';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<code>npm install --save-dev typescript</code>');
    expect(visible(html)).toContain('and then add a tsconfig.json to the project root.');
    expect(codes(diagnostics)).toContain('code-span-auto-closed');
  });

  it('closes after a single SCREAMING_SNAKE token followed by lowercase prose', () => {
    const src = 'Set `DATABASE_URL to the connection string from the dashboard.';
    const { ast, diagnostics } = parse(src);
    const spans = nodesOfType(ast, 'inlineCode');
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe('DATABASE_URL');
    expect(codes(diagnostics)).toContain('code-span-auto-closed');
  });

  it('closes an unclosed code span at end of input when the remainder is all code-like', () => {
    const src = 'The error comes from `src/handlers/auth.py:142';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<code>src/handlers/auth.py:142</code>');
    expect(codes(diagnostics)).toContain('code-span-auto-closed');
  });

  it('never lets an unclosed backtick swallow the following line', () => {
    const src = `The value is \`config.timeout_ms which defaults to 30000.
The next line must stay prose.`;
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    const spans = nodesOfType(ast, 'inlineCode');
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s: any) => !s.value.includes('The next line must stay prose'))).toBe(true);
    expect(visible(html)).toContain('The next line must stay prose.');
  });
});

// ---------------------------------------------------------------------------
// 6. Backticks inside code spans
// ---------------------------------------------------------------------------

describe('backticks inside code spans (nested-backtick pairing)', () => {
  it('prefers one code span over alternating prose/code fragments for `--format=`json``', () => {
    const src = 'Use the `--format=`json`` flag to get machine-readable output.';
    const { ast } = parse(src);
    const spans = nodesOfType(ast, 'inlineCode');
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toContain('--format=');
    expect(spans[0].value).toContain('json');
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain('flag to get machine-readable output.');
  });

  it('keeps the interior backtick literal when markdown talks about markdown', () => {
    const src = 'In markdown, wrap commands like `ls -la` in backticks: `like `this``.';
    const { ast } = parse(src);
    const values = nodesOfType(ast, 'inlineCode').map((n) => n.value);
    expect(values).toContain('ls -la');
    expect(values.some((v) => v.includes('like') && v.includes('`this`'))).toBe(true);
  });

  it('keeps shell command substitution as a single code span', () => {
    const src = 'Run `echo `date`` to print the current time.';
    const { ast } = parse(src);
    const spans = nodesOfType(ast, 'inlineCode');
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe('echo `date`');
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain('to print the current time.');
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed link shapes
// ---------------------------------------------------------------------------

describe('malformed link shapes', () => {
  it('absorbs a single space between ] and ( and still builds the link', () => {
    const src = 'See [the deployment guide] (https://docs.internal.corp/deploy/v2) before touching prod.';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<a href="https://docs.internal.corp/deploy/v2">the deployment guide</a>');
    expect(codes(diagnostics)).toContain('link-space-before-paren');
  });

  it('synthesizes the missing ] in [text(url)', () => {
    const src = 'Details are in [the RFC(https://internal.corp/rfc/0042-schema-migration).';
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://internal.corp/rfc/0042-schema-migration');
    expect(inlineText(links[0].children)).toBe('the RFC');
  });

  it('un-transposes (text)[url] when only the bracket side is URL-shaped', () => {
    const src = 'Check the (changelog)[https://github.com/acme/api/releases] for breaking changes.';
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://github.com/acme/api/releases');
    expect(inlineText(links[0].children)).toBe('changelog');
  });

  it('synthesizes the parens when a bare URL directly follows ]', () => {
    const src = 'Full context in [this thread]https://slack.com/archives/C024BE91L/p1701234567';
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain('slack.com/archives/C024BE91L/p1701234567');
    expect(inlineText(links[0].children)).toBe('this thread');
  });

  it('bridges a wrapped newline between ] and (', () => {
    const src = `See [the deployment guide]
(https://docs.internal.corp/deploy/v2) before touching prod.`;
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://docs.internal.corp/deploy/v2');
  });
});

// ---------------------------------------------------------------------------
// 8. URL content hazards
// ---------------------------------------------------------------------------

describe('URL content hazards: spaces, parens, truncation', () => {
  it('keeps a space-bearing file path as one destination instead of spilling it into prose', () => {
    const src = 'Download the deck from [Q3 review](https://drive.google.com/file/Q3 Planning Final v2.pdf) and skim slides 4-9.';
    const { ast, diagnostics } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toMatch(/Q3(%20|\s)Planning(%20|\s)Final(%20|\s)v2\.pdf$/);
    expect(inlineText(links[0].children)).toBe('Q3 review');
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain('and skim slides 4-9.');
    expect(codes(diagnostics)).toContain('link-url-spaces');
  });

  it('treats a ) followed by lowercase prose as the missing link closer, keeping inner parens in the URL', () => {
    const src = 'See [Recursion](https://en.wikipedia.org/wiki/Recursion_(computer_science) for the formal definition.';
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://en.wikipedia.org/wiki/Recursion_(computer_science)');
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain('for the formal definition.');
  });

  it('closes a truncated destination at end of input and reports it', () => {
    const src = 'The incident timeline is at [the postmortem](https://wiki.corp.example.com/display/SRE/2026-07-14+API+Gateway+Outage';
    const { ast, diagnostics } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://wiki.corp.example.com/display/SRE/2026-07-14+API+Gateway+Outage');
    expect(codes(diagnostics)).toContain('link-unclosed');
  });
});

// ---------------------------------------------------------------------------
// 9. Bare URLs / autolinking
// ---------------------------------------------------------------------------

describe('bare URLs expected to autolink', () => {
  it('autolinks a bare https URL and leaves the sentence comma outside the href', () => {
    const src = 'Track progress in https://github.com/acme/gateway/issues/1287, and ping me if it stalls.';
    const { ast, diagnostics } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://github.com/acme/gateway/issues/1287');
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain(', and ping me if it stalls.');
    expect(diagnostics.every((d) => d.severity !== 'repair' || d.code !== 'emphasis-auto-closed')).toBe(true);
  });

  it('protects underscores inside an autolinked URL from the emphasis parser', () => {
    const src = 'The dashboard lives at https://grafana.corp.example.com/d/api_latency_p99/overview (staging uses grafana-stg).';
    const { html } = render(src);
    expect(html).toContain('href="https://grafana.corp.example.com/d/api_latency_p99/overview"');
    expect(html).not.toContain('<em>');
    expect(visible(html)).toContain('api_latency_p99');
  });

  it('autolinks a www. host with an implied scheme', () => {
    const src = 'More examples at www.commonmark.org/help and in the spec.';
    const { ast } = parse(src);
    const links = nodesOfType(ast, 'link');
    expect(links).toHaveLength(1);
    expect(links[0].url).toMatch(/^https?:\/\/www\.commonmark\.org\/help$/);
    expect(inlineText(links[0].children)).toBe('www.commonmark.org/help');
  });
});

// ---------------------------------------------------------------------------
// 10. Reference links with missing definitions
// ---------------------------------------------------------------------------

describe('reference-style links with missing definitions', () => {
  it('resolves the defined reference and degrades the undefined sibling without showing raw brackets', () => {
    const src = `This mirrors the approach in [the Raft paper][1] and the [etcd implementation][2].

[1]: https://raft.github.io/raft.pdf`;
    const { html } = render(src);
    expect(html).toContain('href="https://raft.github.io/raft.pdf"');
    expect(visible(html)).toContain('etcd implementation');
    expect(visible(html)).not.toContain('[2]');
    expect(visible(html)).not.toContain('][');
  });

  it('leaves a bare bracketed citation as literal text, not a link', () => {
    const src = 'As described in [Kleppmann 2017], log compaction bounds storage growth.';
    const { html } = render(src);
    expect(nodesOfType(parse(src).ast, 'link')).toHaveLength(0);
    expect(visible(html)).toBe('As described in [Kleppmann 2017], log compaction bounds storage growth.');
  });

  it('renders a two-bracket reference whose definition never arrived without bracket debris', () => {
    const src = 'See the [official docs][docs] for the full flag list.';
    const { html } = render(src);
    expect(visible(html)).toContain('official docs');
    expect(visible(html)).not.toContain('[docs]');
    expect(visible(html)).not.toContain('[official docs]');
  });

  it('recovers reference definitions the model stranded inside an untagged code fence', () => {
    const src = [
      'See the [spec][s] for the full grammar.',
      '',
      '```',
      '[s]: https://example.com/spec',
      '```',
    ].join('\n');
    const { html } = render(src);
    expect(html).toContain('href="https://example.com/spec"');
  });
});

// ---------------------------------------------------------------------------
// 11. Image syntax errors
// ---------------------------------------------------------------------------

describe('image syntax errors', () => {
  it('absorbs the space in "! [alt](url)" and still produces an image, not a link', () => {
    const src = '! [Architecture diagram](https://raw.githubusercontent.com/acme/gateway/main/docs/arch.png)';
    const { ast } = parse(src);
    const images = nodesOfType(ast, 'image');
    expect(images).toHaveLength(1);
    expect(images[0].alt).toBe('Architecture diagram');
    expect(images[0].url).toBe('https://raw.githubusercontent.com/acme/gateway/main/docs/arch.png');
    expect(nodesOfType(ast, 'link')).toHaveLength(0);
  });

  it('synthesizes parens for ![alt] followed by a bare (sandbox) destination', () => {
    const src = '![Latency histogram after the fix]sandbox:/mnt/data/latency_hist.png';
    const { ast } = parse(src);
    const images = nodesOfType(ast, 'image');
    expect(images).toHaveLength(1);
    expect(images[0].alt).toBe('Latency histogram after the fix');
    expect(images[0].url).toBe('sandbox:/mnt/data/latency_hist.png');
  });

  it('relocates a transposed bang in [!alt](url) into an image', () => {
    const src = 'Here it is: [!Architecture diagram](https://example.com/arch.png)';
    const { ast } = parse(src);
    const images = nodesOfType(ast, 'image');
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://example.com/arch.png');
  });

  it('treats [!NOTE] at line start with no paren as an admonition marker, never an image', () => {
    const src = '[!NOTE] The cache is invalidated on every deploy.';
    const { ast, diagnostics } = parse(src);
    expect(nodesOfType(ast, 'image')).toHaveLength(0);
    expect(nodesOfType(ast, 'link')).toHaveLength(0);
    expect(codes(diagnostics)).not.toContain('link-unclosed');
  });
});

// ---------------------------------------------------------------------------
// 12. Backslash escape misuse
// ---------------------------------------------------------------------------

describe('backslash escape misuse', () => {
  it('preserves every backslash of a Windows path and does not italicize svc_gateway', () => {
    const src = String.raw`Logs are written to C:\Users\svc_gateway\AppData\Local\Temp\gw.log on Windows hosts.`;
    const { html } = render(src);
    expect(visible(html)).toBe(src);
    expect(html).not.toContain('<em>');
  });

  it('honors unnecessary escapes without ever rendering the backslash', () => {
    const src = String.raw`Rename the field to user\_id and drop the legacy \_v1 suffix from all payloads.`;
    const { html } = render(src);
    expect(visible(html)).toBe('Rename the field to user_id and drop the legacy _v1 suffix from all payloads.');
    expect(visible(html)).not.toContain('\\');
    expect(html).not.toContain('<em>');
  });

  it('does not let the live * of a double-escaped \\\\* open emphasis over the rest of the line', () => {
    const src = String.raw`Multiply by the weight \\* attention mask before the softmax.`;
    const { html } = render(src);
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
    expect(visible(html)).toContain('*');
    expect(visible(html)).toContain('attention mask before the softmax.');
  });
});

// ---------------------------------------------------------------------------
// 13. Math delimiter collisions
// ---------------------------------------------------------------------------

describe('math delimiters colliding with emphasis, brackets, and currency', () => {
  it('keeps three inline math spans intact and never fuses subscripts into emphasis', () => {
    const src = String.raw`The loss is $L = \sum_i (y_i - \hat{y}_i)^2$ averaged over the batch, so $x_i$ and $y_j$ share the index set.`;
    const { ast } = parse(src);
    const math = nodesOfType(ast, 'inlineMath');
    expect(math).toHaveLength(3);
    expect(math[0].value).toContain(String.raw`\sum_i`);
    expect(math[1].value).toBe('x_i');
    expect(math[2].value).toBe('y_j');
    expect(nodesOfType(ast, 'emphasis')).toHaveLength(0);
    expect(nodesOfType(ast, 'strong')).toHaveLength(0);
  });

  it('leaves currency amounts literal instead of fusing them into a math span', () => {
    const src = 'Revenue grew from $3M to $4.2M this quarter, a record for the team.';
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'inlineMath')).toHaveLength(0);
    expect(visible(html)).toContain('$3M');
    expect(visible(html)).toContain('$4.2M');
  });

  it('parses \\( \\) and \\[ \\] before escape processing so braces and subscripts survive', () => {
    const src = String.raw`where \( \alpha = 0.9 \) controls momentum and the update is \[ w_{t+1} = w_t - \eta \nabla L \] applied per step.`;
    const { ast } = parse(src);
    const math = [...nodesOfType(ast, 'inlineMath'), ...nodesOfType(ast, 'mathBlock')];
    expect(math.length).toBeGreaterThanOrEqual(2);
    expect(math.some((m) => m.value.includes(String.raw`\alpha`))).toBe(true);
    expect(math.some((m) => m.value.includes('w_{t+1}'))).toBe(true);
    expect(nodesOfType(ast, 'emphasis')).toHaveLength(0);
    expect(inlineText(nodesOfType(ast, 'paragraph')[0].children)).toContain('controls momentum');
  });

  it('matches a $$ opener against a single $ closer and keeps the trailing prose out of the math', () => {
    const src = String.raw`The bound is $$\mathbb{E}[X] \le \sqrt{2\sigma^2 \log n}$ for sub-Gaussian noise.`;
    const { ast, diagnostics } = parse(src);
    const math = [...nodesOfType(ast, 'inlineMath'), ...nodesOfType(ast, 'mathBlock')];
    expect(math).toHaveLength(1);
    expect(math[0].value).toContain(String.raw`\mathbb{E}[X]`);
    expect(math[0].value).not.toContain('sub-Gaussian');
    expect(codes(diagnostics)).toContain('math-auto-closed');
  });
});

// ---------------------------------------------------------------------------
// 14. Inline HTML fragments and angle-bracket tokens that are not HTML
// ---------------------------------------------------------------------------

describe('inline HTML fragments and angle-bracket lookalikes', () => {
  it('maps allowlisted <b> and <br> onto native strong and hard-break nodes', () => {
    const src = 'Set the header to <b>application/json</b> or the request will be rejected.<br>Retry with backoff on 429.';
    const { ast } = parse(src);
    expect(nodesOfType(ast, 'strong').map((s) => inlineText(s.children))).toContain('application/json');
    expect(nodesOfType(ast, 'hardBreak').length).toBeGreaterThan(0);
  });

  it('keeps an ALLCAPS placeholder visible instead of eating it as a tag', () => {
    const { html } = render('Paste your token where it says <YOUR_API_KEY> in the config below.');
    expect(html).toContain('&lt;YOUR_API_KEY&gt;');
    expect(visible(html)).toBe('Paste your token where it says <YOUR_API_KEY> in the config below.');
  });

  it('leaves nested generic type syntax exactly as written', () => {
    const src = 'The handler returns a Promise<Map<string, number>> so callers must await it.';
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'htmlInline')).toHaveLength(0);
    expect(visible(html)).toBe(src);
  });

  it('scopes an unclosed <div> to its own block rather than swallowing the document', () => {
    const src = `<div class="warning">
Do not run this against production. The script issues DELETEs without a dry-run flag.

The next paragraph must survive outside the callout.`;
    const { html, diagnostics } = render(src);
    expect(html).toContain('</div>');
    expect(visible(html)).toContain('Do not run this against production.');
    expect(visible(html)).toContain('The next paragraph must survive outside the callout.');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('turns <team@corp.com> into a mailto autolink', () => {
    const { html } = render('Email <team@corp.com> for access.');
    expect(html).toContain('href="mailto:team@corp.com"');
  });

  it('does not enter HTML mode for comparison operators', () => {
    const src = 'Ensure x < 10 and y > 3 before calling the estimator.';
    const { ast, html, diagnostics } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'htmlInline')).toHaveLength(0);
    expect(visible(html)).toBe(src);
    expect(diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Strikethrough tilde variants
// ---------------------------------------------------------------------------

describe('strikethrough tilde variants and tilde false positives', () => {
  it('strikes the deprecated sentence while leaving ~200ms as an approximation', () => {
    const src = '~~Deprecated: use /v1/users~~ Use /v2/accounts instead. Response time is ~200ms at p50.';
    const { html } = render(src);
    expect(html).toContain('<del>Deprecated: use /v1/users</del>');
    expect(visible(html)).toContain('~200ms');
  });

  it('matches a ~~ opener with a single ~ closer on the same line', () => {
    const src = 'The old flag ~~--legacy-auth~ was removed in 3.0.';
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    const dels = nodesOfType(ast, 'delete');
    expect(dels).toHaveLength(1);
    expect(inlineText(dels[0].children)).toBe('--legacy-auth');
    expect(visible(html)).toBe('The old flag --legacy-auth was removed in 3.0.');
  });

  it('never pairs two home-directory tildes into a strikethrough', () => {
    const src = 'Config lives in ~/.gateway/config.toml and secrets in ~/.gateway/secrets/.';
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'delete')).toHaveLength(0);
    expect(visible(html)).toBe(src);
  });

  it('maps <del> onto the same delete node as ~~', () => {
    const src = 'The <del>old endpoint</del> is gone.';
    const { ast } = parse(src);
    const dels = nodesOfType(ast, 'delete');
    expect(dels).toHaveLength(1);
    expect(inlineText(dels[0].children)).toBe('old endpoint');
  });
});

// ---------------------------------------------------------------------------
// 16. Smart unicode punctuation and invisible characters
// ---------------------------------------------------------------------------

describe('smart punctuation and invisible characters adjacent to delimiters', () => {
  it('bolds a span that starts and ends with curly quotes', () => {
    const src = '**\u201CDo not merge\u201D** was the review verdict, but CI had already deployed\u2026';
    const { html } = render(src);
    expect(html).toContain('<strong>\u201CDo not merge\u201D</strong>');
    expect(visible(html)).not.toContain('*');
  });

  it('treats NBSP padding inside ** exactly like space padding', () => {
    const src = 'The rollout is **\u00A0blocked\u00A0** until legal signs off.';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<strong>blocked</strong>');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('emphasis-space-padded');
  });

  it('preserves curly quotes inside a code span byte-for-byte', () => {
    const src = 'Set the env var to \u201Cproduction\u201D exactly: `NODE_ENV=\u201Cproduction\u201D` will not match the string check.';
    const { ast } = parse(src);
    const spans = nodesOfType(ast, 'inlineCode');
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe('NODE_ENV=\u201Cproduction\u201D');
  });

  it('warns about typographic quotes inside a code span instead of silently passing them through', () => {
    const src = 'Set the env var to \u201Cproduction\u201D exactly: `NODE_ENV=\u201Cproduction\u201D` will not match the string check.';
    const { diagnostics } = parse(src);
    expect(diagnostics.some((d) => /quote|typograph|curly|smart/i.test(d.message))).toBe(true);
  });

  it('treats zero-width spaces as transparent to flanking so **\u200Bbold\u200B** still bolds', () => {
    const src = '**\u200BImportant\u200B** \u2014 schema migrations now run in a separate job.';
    const { html, diagnostics } = render(src);
    expect(html).toContain('<strong>Important</strong>');
    expect(visible(html)).not.toContain('*');
    expect(codes(diagnostics)).toContain('doc-invisible-chars');
  });
});

// ---------------------------------------------------------------------------
// Guard tests: well-formed or deliberately literal content must NOT be repaired
// ---------------------------------------------------------------------------

describe('guards: content that must not be "repaired"', () => {
  it('leaves well-formed inline markdown untouched and reports no diagnostics', () => {
    const src = 'Use **bold**, *italic*, `code`, [a link](https://example.com "Home"), and ~~strike~~ correctly.';
    const { html, diagnostics } = render(src);
    expect(diagnostics).toHaveLength(0);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com" title="Home">a link</a>');
    expect(html).toContain('<del>strike</del>');
  });

  it('leaves a well-formed ***bold italic*** run alone', () => {
    const { html, diagnostics } = render('Ship it ***only*** after review.');
    expect(html).toContain('<em><strong>only</strong></em>');
    expect(diagnostics).toHaveLength(0);
  });

  it('does not emphasize arithmetic written as a * b * c', () => {
    const src = 'Compute the product a * b * c before normalizing the rows.';
    const { html, diagnostics } = render(src);
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
    expect(visible(html)).toBe(src);
    expect(diagnostics).toHaveLength(0);
  });

  it('does not bold Python exponentiation written as 2 ** 3', () => {
    const src = 'In Python, 2 ** 3 evaluates to 8, and 10 ** 6 is a million.';
    const { html } = render(src);
    expect(html).not.toContain('<strong>');
    expect(visible(html)).toBe(src);
  });

  it('does not italicize snake_case identifiers in prose', () => {
    const src = 'The columns are user_id, created_at, and updated_at in the events table.';
    const { html, diagnostics } = render(src);
    expect(html).not.toContain('<em>');
    expect(visible(html)).toBe(src);
    expect(diagnostics).toHaveLength(0);
  });

  it('does not treat "$5 and $10" as a math span', () => {
    const src = 'The two tiers cost $5 and $10 per seat per month.';
    const { ast, html, diagnostics } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'inlineMath')).toHaveLength(0);
    expect(visible(html)).toBe(src);
    expect(diagnostics).toHaveLength(0);
  });

  it('does not repair literal markdown syntax shown inside a fenced code block', () => {
    const src = [
      'Here is what a broken snippet looks like:',
      '',
      '```markdown',
      '**unclosed bold and `unclosed code',
      '[broken link] (https://example.com)',
      '~~half strike~',
      '```',
      '',
      'That was the example.',
    ].join('\n');
    const { ast, diagnostics } = parse(src);
    const blocks = nodesOfType(ast, 'codeBlock');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value).toContain('**unclosed bold and `unclosed code');
    expect(blocks[0].value).toContain('[broken link] (https://example.com)');
    const inlineRepairs = codes(diagnostics).filter((c) =>
      ['emphasis-auto-closed', 'emphasis-space-padded', 'code-span-auto-closed', 'link-space-before-paren', 'link-unclosed'].includes(c),
    );
    expect(inlineRepairs).toHaveLength(0);
  });

  it('does not turn an ordinary parenthetical followed by brackets into a transposed link', () => {
    const src = 'The retry budget (three attempts) [see the SRE handbook] is configurable.';
    const { ast, html } = { ...parse(src), ...render(src) } as any;
    expect(nodesOfType(ast, 'link')).toHaveLength(0);
    expect(visible(html)).toBe(src);
  });
});
