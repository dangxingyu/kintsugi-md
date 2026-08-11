import fs from 'fs';
import { parse, renderHtml } from '/Users/bytedance/playground/markdown-parser/dist/index.js';
import MarkdownIt from 'markdown-it';
const lines = fs.readFileSync('/Users/bytedance/playground/markdown-parser/data/readmes.jsonl','utf8').split('\n').filter(Boolean);
let text=null;
for (const l of lines){const o=JSON.parse(l); if(o.repo==='0xInfection/Awesome-WAF'){text=o.text;break;}}
const res = parse(text);
const diags = res.diagnostics.filter(d=>d.code==='list-indent-adjusted');
console.log('total list-indent-adjusted diags in real doc:', diags.length);
console.log('near 3635:', JSON.stringify(diags.filter(d=>d.line>3600&&d.line<3700)));
const html = renderHtml(res.doc ?? res);
fs.writeFileSync('/private/tmp/claude-501/-Users-bytedance-playground-markdown-parser/dd9bad56-2c98-47ce-a3fe-84af26a8c972/scratchpad/kin.html', html);
const md = new MarkdownIt({html:true, linkify:false});
fs.writeFileSync('/private/tmp/claude-501/-Users-bytedance-playground-markdown-parser/dd9bad56-2c98-47ce-a3fe-84af26a8c972/scratchpad/ref.html', md.render(text));
console.log('auto-closed count kintsugi:', (html.match(/data-auto-closed/g)||[]).length);
