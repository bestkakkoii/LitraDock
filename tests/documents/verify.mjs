import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {citations,readingHtml} from '../../src/document-worker/worker.mjs';

const output=resolve(process.argv[2]??'.litradock/document-tests');await mkdir(output,{recursive:true});
const checks=[];const start=performance.now();const check=(condition,name)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
const item={id:'LD-KNOWN-1',type:'article-journal',title:'A study',author:[{family:'Smith',given:'Jane'}],issued:{'date-parts':[[2020]]},'container-title':'Science',volume:'10',page:'1-5'};
const apa=citations({style:'apa',items:[item]});check(apa.citation==='(Smith, 2020)' && apa.bibliography[0]==='Smith, J. (2020). A study. Science, 10, 1–5.','Known APA author/date, initials, container, volume and page-range output');
const ieee=citations({style:'ieee',items:[item,{...item,id:'LD-KNOWN-2',author:[{literal:'Research Council'}],title:'第二研究'}]});check(ieee.citation.includes('1') && ieee.bibliography.some(x=>x.includes('Research Council')) && ieee.ids.join(',')==='LD-KNOWN-1,LD-KNOWN-2','Numeric citation order separate from stable identity and corporate author retained');
assert.throws(()=>citations({style:'untrusted-path',items:[item]}));checks.push('Only pinned style identifiers accepted');
assert.throws(()=>readingHtml({format:'xml',source:'<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><article><body>&x;</body></article>'}));checks.push('External XML entities rejected');
let requests=0;const canary=createServer((req,res)=>{requests++;res.end('PRIVATE-CANARY');});await new Promise(resolve=>canary.listen(0,'127.0.0.1',resolve));const target=`http://127.0.0.1:${canary.address().port}/private`;
async function render(name,input){
  const worker=spawn(process.execPath,['src/document-worker/worker.mjs'],{stdio:['pipe','pipe','pipe'],windowsHide:true});const stdout=[],stderr=[];worker.stdout.on('data',x=>stdout.push(x));worker.stderr.on('data',x=>stderr.push(x));worker.stdin.end(JSON.stringify({...input,operation:'reading'}));const exit=await new Promise(resolve=>worker.on('exit',resolve));await writeFile(resolve(output,name+'-stderr.txt'),Buffer.concat(stderr));if(exit!==0)throw Error('Actual renderer failed: '+Buffer.concat(stderr));
  const result=JSON.parse(Buffer.concat(stdout));await writeFile(resolve(output,name+'.pdf'),Buffer.from(result.pdf,'base64'));delete result.pdf;await writeFile(resolve(output,name+'-result.json'),JSON.stringify(result,null,2));return result;
}
try {
 const source='<article><body><sec><title>Structure and multilingual evidence</title><p>English 中文研究 Ελληνικά Русский. Water H<sub>2</sub>O; E=mc<sup>2</sup>.</p><disp-formula><math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>a</mi><mi>b</mi></mfrac></math></disp-formula><fig><caption><p>Figure one caption.</p></caption><graphic href="'+target+'"/></fig><fig><caption><p>Embedded red-blue figure.</p></caption><graphic href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAI0lEQVR4nGP4z8BAEiJR+X9SlY9aMGrBqAWjFoxawDAQFgAAUKb+EI79688AAAAASUVORK5CYII="/></fig><table-wrap><table><thead><tr><th>Index</th><th>Observation</th></tr></thead><tbody>'+Array.from({length:160},(_,i)=>`<tr><td>${i+1}</td><td>Exact observation ${i+1}: 3.14159</td></tr>`).join('')+'</tbody></table></table-wrap></sec></body><back><fn><p>Footnote retained.</p></fn><ref-list><title>References</title><ref id="ref1">Smith 2020 <ext-link href="https://doi.org/10.1000/example">Reference link</ext-link></ref></ref-list></back></article>';
 const reading=await render('reading',{id:'LD-FIDELITY-001',title:'Synthetic structural reading fixture',source,format:'xml',mode:'original',inputHash:createHash('sha256').update(source).digest('hex')});
 check(reading.kind==='Formatted Reading Copy' && reading.warnings.some(x=>x.includes('media')),'Actual XML PDF reports unavailable media without full-text invention');
 const html=await render('html',{id:'LD-HTML-001',title:'Two-column source semantic content',format:'html',mode:'original',inputHash:'b'.repeat(64),source:`<html><head><style>body{background:url(${target})}</style></head><body><div style="columns:2"><h2>Left source column</h2><p>First logical paragraph.</p><h2>Right source column</h2><p>Second logical paragraph.</p></div><script>fetch('${target}')</script><iframe src="${target}"></iframe><img src="${target}"><p onclick="fetch('${target}')">Final retained paragraph.</p></body></html>`});
 check(html.warnings.some(x=>x.includes('reformatted')),'Two-column HTML semantics retained with explicit layout limitation');
 check(reading.images===1,'Supported embedded figure retained as decoded image');
 const abstract=await render('abstract',{id:'LD-ABSTRACT-001',title:'Abstract evidence',format:'text',mode:'abstract',inputHash:'c'.repeat(64),source:'Only the available abstract. 中文摘要. No methods or results are invented.'});
 check(abstract.kind==='Abstract Only','Actual abstract output has distinct artifact label');
 check(requests===0 && reading.blockedRequests===0 && html.blockedRequests===0,'Actual loopback canary receives zero source-script/image/style/frame requests');
 await writeFile(resolve(output,'citations.json'),JSON.stringify({apa,ieee},null,2));
 await writeFile(resolve(output,'result.json'),JSON.stringify({checks:checks.length,names:checks,elapsedMs:Math.round(performance.now()-start),node:process.version,platform:process.platform,liveSourceRequests:0},null,2));
}finally{await new Promise(resolve=>canary.close(resolve));}
