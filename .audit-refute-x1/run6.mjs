import fs from 'fs';
import * as K from '../dist/index.js';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const t=doc.split('\n');
const fired=new Set(K.render(doc).diagnostics.filter(d=>d.code==='list-indent-adjusted').map(d=>d.line));
const miss=[];
for(let i=1;i<t.length;i++){
  if(/^[-*+] /.test(t[i-1]) && /^```/.test(t[i])){
    if(!fired.has(i+1)) miss.push((i+1)+'  bullet@'+i+': '+t[i-1].slice(0,70));
  }
}
console.log('flush constructs NOT nested by kintsugi:',miss.length);
console.log(miss.join('\n'));
