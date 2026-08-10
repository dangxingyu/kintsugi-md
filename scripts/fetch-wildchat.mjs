/**
 * Sample assistant turns from allenai/WildChat-1M.
 *
 * WildChat is real, in-the-wild LLM output rather than a curated benchmark,
 * which is exactly what we want: the markdown in it was produced under the same
 * conditions that produce the mistakes this parser exists to survive. It is
 * ungated, and it carries a per-row `language` field, so we can deliberately
 * over-sample the scripts where the current English-only rule is blind.
 *
 * Writes one JSON object per line: {text, language, model}.
 *
 * Usage: node scripts/fetch-wildchat.mjs [batches] [outPath]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://datasets-server.huggingface.co/rows';
const DATASET = 'allenai%2FWildChat-1M';
const PAGE = 100;
// Spread offsets across the corpus rather than reading the head, so we are not
// sampling one slice of one week's traffic.
const TOTAL_ROWS = 1_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset, attempt = 0) {
  const url = `${BASE}?dataset=${DATASET}&config=default&split=train&offset=${offset}&length=${PAGE}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.rows ?? [];
  } catch (e) {
    if (attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return fetchPage(offset, attempt + 1);
    }
    return [];
  }
}

function assistantTurns(row) {
  const out = [];
  const conv = row?.row?.conversation;
  if (!Array.isArray(conv)) return out;
  for (const t of conv) {
    if (!/assistant/i.test(t.role ?? '')) continue;
    const content = t.content;
    if (typeof content !== 'string' || content.length < 120) continue;
    out.push({
      text: content,
      language: row.row.language ?? t.language ?? 'unknown',
      model: row.row.model ?? 'unknown',
    });
  }
  return out;
}

async function main() {
  const batches = Number(process.argv[2] ?? 240);
  const outPath = process.argv[3] ?? 'data/wildchat-assistant.jsonl';

  // Resume support: this is a slow network job and should not restart from zero.
  const seen = new Set();
  let rows = [];
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        rows.push(o);
        seen.add(o.text.slice(0, 120));
      } catch {
        /* ignore a partial trailing line */
      }
    }
    console.log(`resuming with ${rows.length} rows already on disk`);
  }

  const step = Math.floor(TOTAL_ROWS / batches);
  const CONCURRENCY = 6;
  let done = 0;

  for (let i = 0; i < batches; i += CONCURRENCY) {
    const group = [];
    for (let k = 0; k < CONCURRENCY && i + k < batches; k++) {
      group.push(fetchPage((i + k) * step));
    }
    const pages = await Promise.all(group);
    for (const page of pages) {
      for (const r of page) {
        for (const turn of assistantTurns(r)) {
          const key = turn.text.slice(0, 120);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(turn);
        }
      }
    }
    done += group.length;
    if (done % 30 === 0 || done >= batches) {
      const langs = {};
      for (const r of rows) langs[r.language] = (langs[r.language] ?? 0) + 1;
      const top = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([l, n]) => `${l}:${n}`).join(' ');
      console.log(`  ${done}/${batches} batches — ${rows.length} assistant turns — ${top}`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    await sleep(200);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nwrote ${outPath} (${rows.length} assistant turns)`);
}

main();
