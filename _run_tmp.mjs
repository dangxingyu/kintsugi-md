import fs from 'fs';
import * as K from '/Users/bytedance/playground/markdown-parser/dist/index.js';
import MarkdownIt from '/Users/bytedance/playground/markdown-parser/node_modules/markdown-it/index.mjs';
const md = new MarkdownIt();
const lines = fs.readFileSync('/Users/bytedance/playground/markdown-parser/data/readmes.jsonl','utf8').split('\n');
let text=null;
for (const l of lines){ if(!l.trim()) continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){text=o.text;break;} }
const src = text.split('\n').slice(3628, 3682).join('\n');
console.log('=== SOURCE ===');
console.log(src);
console.log('=== KINTSUGI ===');
const r = K.parse ? K.parse(src) : null;
console.log(Object.keys(K));
