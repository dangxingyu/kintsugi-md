import fs from 'fs';
import { render } from '/Users/bytedance/playground/markdown-parser/dist/index.js';
import MarkdownIt from 'markdown-it';
const SD='/private/tmp/claude-501/-Users-bytedance-playground-markdown-parser/dd9bad56-2c98-47ce-a3fe-84af26a8c972/scratchpad/';
const lines = fs.readFileSync('/Users/bytedance/playground/markdown-parser/data/readmes.jsonl','utf8').split('\n').filter(Boolean);
let hits=[];
for (const l of lines){const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF') hits.push(o);}
console.log('entries for repo:', hits.length, 'text lens:', hits.map(h=>h.text.length));
const text = hits[0].text;
console.log('text lines', text.split('\n').length, 'has 45130?', text.includes('45130'));
const out = render(text);
fs.writeFileSync(SD+'kin.html', out.html);
const md = new MarkdownIt({html:true, linkify:false});
fs.writeFileSync(SD+'ref.html', md.render(text));
console.log('kin len', out.html.length, 'ref len', md.render(text).length);
console.log('kin has 45130?', out.html.includes('45130'), 'ref has?', md.render(text).includes('45130'));
