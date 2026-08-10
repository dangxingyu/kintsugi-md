/**
 * Fetch README files for a list of repos.
 *
 * WildChat turned out to be the wrong corpus for this task — it is
 * conversational, so almost every `#` in it is a code comment inside a fence
 * rather than a markdown heading. READMEs are the opposite: heading-dense,
 * written in many languages, and their headings are unambiguously headings.
 *
 * For the question at hand — *does this text read like a title or like prose?*
 * — human-authored headings are the right supervision. That distinction is a
 * property of language, not of who typed it.
 *
 * Repo discovery is a separate step (the GitHub search API is limited to 30
 * requests/minute); this script only reads raw.githubusercontent.com, which is
 * not rate-limited.
 *
 * Usage: node scripts/fetch-readmes.mjs <repoListFile> [outPath]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Localized variants are worth chasing: they give us Chinese, Japanese, Korean
// and Russian headings written by native speakers rather than translated.
const README_NAMES = [
  'README.md',
  'README_CN.md',
  'README.zh-CN.md',
  'README_zh.md',
  'README-zh_CN.md',
  'README_zh-CN.md',
  'README.ja.md',
  'README_JP.md',
  'README.ko.md',
  'README.ru.md',
  'README.de.md',
  'README.fr.md',
  'README.es.md',
  'README.pt-BR.md',
  'docs/README.md',
];

function detectScript(text) {
  const sample = text.slice(0, 5000);
  if (/[一-鿿]/.test(sample)) return 'chinese';
  if (/[぀-ヿ]/.test(sample)) return 'japanese';
  if (/[가-힯]/.test(sample)) return 'korean';
  if (/[Ѐ-ӿ]/.test(sample)) return 'cyrillic';
  if (/[؀-ۿ]/.test(sample)) return 'arabic';
  if (/[À-ɏ]/.test(sample)) return 'latin-accented';
  return 'english';
}

async function fetchOne(repo, name) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length < 400 || text.length > 400_000) return null;
    return text;
  } catch {
    return null;
  }
}

async function main() {
  const listPath = process.argv[2] ?? 'data/repos.txt';
  const outPath = process.argv[3] ?? 'data/readmes.jsonl';

  const repos = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

  const rows = [];
  const seen = new Set();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        rows.push(o);
        seen.add(o.repo + '/' + o.file);
      } catch { /* partial trailing line */ }
    }
  }

  const CONCURRENCY = 16;
  const flush = () => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const slice = repos.slice(i, i + CONCURRENCY);
    const groups = await Promise.all(
      slice.map(async (repo) => {
        const out = [];
        for (const name of README_NAMES) {
          if (seen.has(repo + '/' + name)) continue;
          const text = await fetchOne(repo, name);
          if (text) out.push({ repo, file: name, text, script: detectScript(text) });
          // If the main README is missing the repo layout is unusual; do not
          // spend a dozen requests probing for localized variants.
          if (name === 'README.md' && !text) break;
        }
        return out;
      }),
    );
    for (const g of groups) {
      for (const r of g) {
        const key = r.repo + '/' + r.file;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
    }
    const done = Math.min(i + CONCURRENCY, repos.length);
    if (done % 320 === 0 || done >= repos.length) {
      const byScript = {};
      for (const r of rows) byScript[r.script] = (byScript[r.script] ?? 0) + 1;
      const top = Object.entries(byScript).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join(' ');
      console.log(`${done}/${repos.length} repos — ${rows.length} readmes — ${top}`);
      flush();
    }
  }

  flush();
  console.log(`\nwrote ${outPath} (${rows.length} readmes)`);
}

main();
