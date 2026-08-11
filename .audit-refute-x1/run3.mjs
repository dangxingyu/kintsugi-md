import fs from 'fs';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const t=doc.split('\n');
let flush=0, indented=0, ex=[];
for(let i=1;i<t.length;i++){
  if(/^\s*[-*+] /.test(t[i-1]) && /^\s*```/.test(t[i])){
    const ind = t[i].match(/^\s*/)[0].length;
    if(ind===0) flush++; else { indented++; ex.push(i+1+': '+JSON.stringify(t[i-1].slice(0,60))+' | '+JSON.stringify(t[i])); }
  }
}
console.log('bullet immediately followed by fence -> flush-left:',flush,' indented:',indented);
console.log(ex.slice(0,20).join('\n'));
