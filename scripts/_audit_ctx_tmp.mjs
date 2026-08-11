// Usage: node ctx.mjs <repo> <focusLineSubstring> [before] [after]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse, renderHtml } from '/Users/bytedance/playground/markdown-parser/dist/index.js';
const require = createRequire(import.meta.url);
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({ html: true, linkify: false });

const [repo, needle, beforeArg, afterArg] = process.argv.slice(2);
const before = Number(beforeArg ?? 12), after = Number(afterArg ?? 12);
const docs = readFileSync('/Users/bytedance/playground/markdown-parser/data/readmes.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.repo === repo);
if (!docs.length) { console.log('NO DOC', repo); process.exit(0); }
for (const d of docs) {
  const lines = d.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    const lo = Math.max(0, i - before), hi = Math.min(lines.length, i + after + 1);
    const win = lines.slice(lo, hi).join('\n');
    console.log(`===== ${repo} match at line ${i + 1} (window ${lo + 1}..${hi}) =====`);
    win.split('\n').forEach((l, k) => console.log(String(lo + k + 1).padStart(5), (lo + k === i ? '>>' : '  '), l));
    console.log('--- KINTSUGI(window) ---');
    const r = parse(win);
    console.log(renderHtml(r.ast));
    console.log('--- diagnostics ---');
    for (const g of r.diagnostics) console.log(' ', g.severity, g.code, 'line', g.line, '|', g.message);
    console.log('--- MARKDOWN-IT(window) ---');
    console.log(md.render(win));
    break;
  }
}
