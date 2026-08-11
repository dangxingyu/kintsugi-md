import fs from 'fs';
import MarkdownIt from 'markdown-it';
import * as K from '../dist/index.js';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const t = doc.split('\n');
const a=Number(process.argv[2]), b=Number(process.argv[3]);
const seg = t.slice(a-1,b).join('\n');
const md = new MarkdownIt({html:true,linkify:false});
console.log('=== SOURCE ===');
console.log(seg);
console.log('=== MARKDOWN-IT ===');
console.log(md.render(seg));
console.log('=== KINTSUGI ===');
const r = K.parse ? K.parse(seg) : null;
console.log(Object.keys(K));
