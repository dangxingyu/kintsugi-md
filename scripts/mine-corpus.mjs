/**
 * Build a labelled corpus for the bold-line-as-heading classifier.
 *
 * Hand-labelling is unnecessary here, because real markdown already encodes the
 * answer. The question the classifier must settle is: *does this text read like
 * a section title, or like prose?* Both classes are abundant and unambiguous in
 * any document, in any language:
 *
 *   POSITIVE — the text of a real ATX heading (`## Results`). The author marked
 *     it as a title, so whatever makes it title-like is exactly the signal we
 *     want when a model writes `**Results**` instead.
 *
 *   NEGATIVE — a sentence from a paragraph, and bold spans used mid-sentence.
 *     The author demonstrably meant running prose.
 *
 * The one trap worth naming: headings are short and paragraphs are long, so
 * sampling negatives naively lets the model score well by learning "short means
 * heading" and nothing else. That would collapse the moment it met a short
 * sentence — which is precisely the `**Never deploy on a Friday**` case we are
 * trying to fix. So negatives are LENGTH-MATCHED to the positive distribution,
 * which removes length as a shortcut and forces the model onto punctuation,
 * structure and script-level signals that actually generalise.
 *
 * Usage: node scripts/mine-corpus.mjs <input.jsonl|dir> [outputPath]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';

const MD_EXT = new Set(['.md', '.markdown', '.mdx', '.txt']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(p, out);
    } else if (MD_EXT.has(extname(entry)) || extname(entry) === '.jsonl') {
      out.push(p);
    }
  }
  return out;
}

function extractDocs(raw, ext) {
  if (ext !== '.jsonl') return [{ text: raw, language: 'unknown' }];
  const docs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.text === 'string') {
      docs.push({ text: o.text, language: o.language ?? o.script ?? 'unknown' });
      continue;
    }
    const turns = o.conversation ?? o.conversations ?? o.messages ?? null;
    if (Array.isArray(turns)) {
      for (const t of turns) {
        const role = t.role ?? t.from ?? '';
        const content = t.content ?? t.value ?? '';
        if (/assistant|gpt|bot|model/i.test(role) && typeof content === 'string' && content.length > 100) {
          docs.push({ text: content, language: o.language ?? 'unknown' });
        }
      }
    }
  }
  return docs;
}

function annotate(doc) {
  const lines = doc.replace(/\r\n?/g, '\n').split('\n');
  const inFence = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence === null && m) {
      fence = m[1][0];
      inFence[i] = true;
      continue;
    }
    if (fence !== null) {
      inFence[i] = true;
      if (m && m[1][0] === fence && m[2].trim() === '') fence = null;
    }
  }
  return { lines, inFence };
}

function looksLikeParagraph(line) {
  const t = line.trim();
  if (t === '') return false;
  return !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|:::)/.test(t);
}

function nextNonBlank(lines, from) {
  for (let i = from; i < lines.length; i++) if (lines[i].trim() !== '') return lines[i];
  return null;
}

/** Strip inline markup so the classifier sees the text, not the syntax. */
function clean(s) {
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * Split a paragraph into sentences across scripts. Latin terminal punctuation
 * plus CJK fullwidth stops, so Chinese and Japanese paragraphs are not returned
 * as one giant "sentence".
 */
function sentences(text) {
  return text
    .split(/(?<=[.!?。！？；;])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function mineDocument(doc, language, source) {
  const positives = [];
  const negatives = [];
  const { lines, inFence } = annotate(doc);

  let atx = 0;
  let boldOnly = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^ {0,3}#{1,6} +\S/.test(lines[i])) atx++;
    if (/^\s*(\*\*\*|\*\*|__)(.+?)\1\s*$/.test(lines[i])) boldOnly++;
  }
  const total = Math.max(lines.length, 1);

  const base = (i) => ({
    language,
    source,
    siblingBoldLines: boldOnly,
    followedByBlank: (lines[i + 1] ?? '').trim() === '',
    followedByParagraph: (() => {
      const n = nextNonBlank(lines, i + 1);
      return n !== null && looksLikeParagraph(n);
    })(),
    relativePosition: i / total,
  });

  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const line = lines[i];

    // ---- POSITIVE: a real ATX heading ----
    const h = /^ {0,3}#{1,6} +(\S.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = clean(h[1]);
      if (text.length > 0 && text.length <= 120) {
        positives.push({
          label: 1,
          text,
          delimiter: '**',
          // Exclude this heading from the document-style feature, or it leaks.
          docUsesAtx: atx - 1 >= 2,
          ...base(i),
        });
      }
      continue;
    }

    if (!looksLikeParagraph(line)) continue;

    // ---- NEGATIVE (a): bold used mid-sentence — emphasis by construction ----
    const inline = /(\*\*\*|\*\*|__)(.+?)\1/.exec(line);
    if (inline && !/^\s*(\*\*\*|\*\*|__)(.+?)\1\s*$/.test(line)) {
      const before = line.slice(0, inline.index).trim();
      const after = line.slice(inline.index + inline[0].length).trim();
      const text = clean(inline[2]);
      if (text.length > 0 && text.length <= 120 && (before.length > 8 || after.length > 8)) {
        negatives.push({ label: 0, text, delimiter: inline[1], docUsesAtx: atx >= 2, ...base(i) });
      }
    }

    // ---- NEGATIVE (b): plain sentences from prose ----
    for (const s of sentences(clean(line))) {
      if (s.length > 0 && s.length <= 120) {
        negatives.push({ label: 0, text: s, delimiter: '**', docUsesAtx: atx >= 2, ...base(i) });
      }
    }
  }

  return { positives, negatives };
}

/**
 * Down-sample negatives so their length distribution matches the positives'.
 * Without this the classifier can score well on length alone and will fail on
 * exactly the short-sentence case we care about.
 */
function lengthMatch(positives, negatives, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  const bucket = (t) => Math.min(Math.floor(t.length / 10), 12);

  const want = {};
  for (const p of positives) want[bucket(p.text)] = (want[bucket(p.text)] ?? 0) + 1;

  const pool = {};
  for (const n of negatives) (pool[bucket(n.text)] ??= []).push(n);

  const picked = [];
  for (const [b, count] of Object.entries(want)) {
    const avail = pool[b] ?? [];
    // Shuffle then take, so we do not systematically favour early documents.
    for (let i = avail.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [avail[i], avail[j]] = [avail[j], avail[i]];
    }
    picked.push(...avail.slice(0, count));
  }
  return picked;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('-o');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : 'data/bold-heading.jsonl';
  const inputs = (outIdx >= 0 ? args.slice(0, outIdx) : args).filter(Boolean);
  if (inputs.length === 0) {
    console.error('usage: node scripts/mine-corpus.mjs <input...> -o <outputPath>');
    process.exit(1);
  }

  const files = [];
  for (const input of inputs) {
    const st = statSync(input);
    if (st.isDirectory()) walk(input, files);
    else files.push(input);
  }

  const positives = [];
  const negatives = [];
  let docs = 0;
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const d of extractDocs(raw, extname(f))) {
      docs++;
      const r = mineDocument(d.text, d.language, f);
      positives.push(...r.positives);
      negatives.push(...r.negatives);
    }
  }

  const matched = lengthMatch(positives, negatives);
  const rows = [...positives, ...matched];
  const negSources = {};
  for (const n of matched) negSources[n.source] = (negSources[n.source] ?? 0) + 1;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const byLang = {};
  for (const r of rows) {
    byLang[r.language] ??= { pos: 0, neg: 0 };
    byLang[r.language][r.label === 1 ? 'pos' : 'neg']++;
  }
  console.log(`docs=${docs} positives=${positives.length} negatives(pooled)=${negatives.length} negatives(matched)=${matched.length}`);
  console.log('negatives by source:', JSON.stringify(negSources));
  console.log('\nby language:');
  Object.entries(byLang)
    .sort((a, b) => b[1].pos + b[1].neg - (a[1].pos + a[1].neg))
    .slice(0, 12)
    .forEach(([l, c]) => console.log(`  ${l.padEnd(12)} pos=${String(c.pos).padStart(5)} neg=${String(c.neg).padStart(5)}`));
  console.log(`\nwrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
