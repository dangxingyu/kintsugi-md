import fs from 'fs';
import * as K from '../dist/index.js';
const lines = fs.readFileSync(new URL('../data/readmes.jsonl', import.meta.url),'utf8').split('\n');
let doc=null;
for(const l of lines){ if(!l.trim())continue; const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){doc=o.text;break;} }
const h=K.render(doc).html;
console.log('nested (</code></pre></li>):',(h.match(/<\/code><\/pre><\/li>/g)||[]).length);
console.log('total pre:',(h.match(/<pre/g)||[]).length);
