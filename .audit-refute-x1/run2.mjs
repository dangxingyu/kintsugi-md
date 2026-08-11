import fs from 'fs';
import MarkdownIt from 'markdown-it';
import * as K from '../dist/index.js';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const t = doc.split('\n');
const a=Number(process.argv[2]), b=Number(process.argv[3]);
const seg = t.slice(a-1,b).join('\n');
console.log('=== KINTSUGI HTML ===');
const r = K.render(seg);
console.log(r.html);
console.log('=== DIAGS ===');
for(const d of r.diagnostics) console.log(d.severity, d.code, (a-1+d.line), d.message);
