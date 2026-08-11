import fs from 'fs';
import MarkdownIt from 'markdown-it';
import * as K from '../dist/index.js';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const r=K.render(doc);
const md=new MarkdownIt({html:true,linkify:false});
const ref=md.render(doc);
const nested=(r.html.match(/<pre/g)||[]).length;
console.log('kintsugi <pre> count',nested,'ref <pre> count',(ref.match(/<pre/g)||[]).length);
console.log('kintsugi <ul> count',(r.html.match(/<ul>/g)||[]).length,'ref <ul>',(ref.match(/<ul>/g)||[]).length);
const counts={};
for(const d of r.diagnostics) counts[d.code]=(counts[d.code]||0)+1;
console.log(counts);
// count <pre> inside <li> vs top-level for kintsugi
console.log('kintsugi pre-immediately-after-li-text (nested):',(r.html.match(/\n<pre>/g)||[]).length);
