import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { parse } from 'parse5';
import CSL from 'citeproc';
import { chromium } from 'playwright';

const root = new URL('.', import.meta.url);
const assetManifest = JSON.parse(readFileSync(new URL('assets-manifest.json', root)));
const hash = data => createHash('sha256').update(data).digest('hex');
function asset(path) {
  const declaration = assetManifest.find(x => x.path === path);
  const bytes = readFileSync(new URL(path, root));
  if (!declaration || bytes.length !== declaration.bytes || hash(bytes) !== declaration.sha256) throw Error('Document asset hash mismatch.');
  return bytes;
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textOf = node => node.nodeType === 3 ? node.data : node.nodeName === '#text' ? node.value : children(node).map(textOf).join('');
const children = node => Array.from(node.childNodes ?? []);
const attr = (node, name) => node.getAttribute ? node.getAttribute(name) : node.attrs?.find(x => x.name === name)?.value;
const localName = node => (node.localName ?? node.tagName ?? node.nodeName ?? '').replace(/^.*:/, '').toLowerCase();
const forbidden = new Set(['script','style','iframe','object','embed','form','input','button','link','meta','base','audio','video']);
const ordinary = new Set(['p','div','span','section','h1','h2','h3','h4','h5','h6','b','strong','i','em','u','s','sup','sub','table','thead','tbody','tfoot','tr','td','th','caption','ul','ol','li','blockquote','pre','code','br','hr','figure','figcaption']);
const math = new Set(['math','mrow','mi','mn','mo','ms','mtext','mfrac','msqrt','mroot','msub','msup','msubsup','munder','mover','munderover','mtable','mtr','mtd','mfenced','semantics']);
function safeHref(raw) {
  if (!raw) return null;
  if (/^#[A-Za-z0-9_.:-]+$/.test(raw)) return raw;
  try { const uri = new URL(raw); if (!['https:','http:'].includes(uri.protocol) || uri.username || uri.password) return null; uri.search=''; uri.hash=''; return uri.href; } catch { return null; }
}

// 白名單重新建立靜態排版；不執行來源 HTML、CSS、JavaScript，也不讀取其遠端或本機資源。
export function readingHtml(input) {
  const warnings = new Set(); let nodes=0; let images=0;
  const source = String(input.source ?? '');
  if (Buffer.byteLength(source)>8*1024*1024) throw Error('Reading input exceeds 8 MiB.');
  function emit(node, depth=0) {
    if (++nodes>100000 || depth>100) throw Error('Document structure exceeds conversion bounds.');
    if (node.nodeType===3 || node.nodeName==='#text') return escape(textOf(node));
    const name=localName(node); const nested=()=>children(node).map(x=>emit(x,depth+1)).join('');
    if (forbidden.has(name)) { warnings.add('Active elements and source styles are omitted.'); return ''; }
    if (name==='annotation' || name==='annotation-xml') return '';
    if (name==='img' || name==='graphic' || name==='inline-graphic') {
      const src=attr(node,'src') || attr(node,'xlink:href') || attr(node,'href') || '';
      if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length<3*1024*1024 && ++images<=40) return `<img alt="${escape(attr(node,'alt') || 'Source figure')}" src="${src}">`;
      warnings.add('Referenced external or unsupported media was not retrieved; captions are retained.');
      return '<p class="missing">[Figure/media unavailable in this saved source]</p>';
    }
    if (name==='a' || name==='ext-link' || name==='xref') {
      const uri=safeHref(attr(node,'href') || attr(node,'xlink:href') || (attr(node,'rid') ? '#'+attr(node,'rid') : ''));
      return uri?`<a href="${escape(uri)}">${nested()}</a>`:nested();
    }
    if (name==='tex-math') { warnings.add('TeX formula is retained verbatim; automatic TeX typesetting is not supported.'); return '<pre>'+escape(textOf(node))+'</pre>'; }
    const aliases={'sec':'section','title':'h2','article-title':'h1','abstract':'section','bold':'b','italic':'i','list':'ul','list-item':'li','fig':'figure','table-wrap':'section','fn':'aside','ref-list':'section','ref':'p','disp-formula':'div','inline-formula':'span','label':'strong'};
    const tag=aliases[name] || name;
    if (!ordinary.has(tag) && !math.has(tag) && tag!=='aside') return nested();
    let attributes='';
    const id=attr(node,'id'); if(id && /^[A-Za-z0-9_.:-]{1,120}$/.test(id)) attributes+=` id="${escape(id)}"`;
    for(const key of ['colspan','rowspan']) { const v=attr(node,key); if(v && /^[1-9][0-9]?$/.test(v)) attributes+=` ${key}="${v}"`; }
    if(math.has(tag)) {
      for(const key of ['display','mathvariant','stretchy','fence','separator','accent']) { const v=attr(node,key); if(v && /^[a-z -]{1,24}$/.test(v)) attributes+=` ${key}="${v}"`; }
      if(tag==='math') attributes+=' xmlns="http://www.w3.org/1998/Math/MathML"';
    }
    return `<${tag}${attributes}>${nested()}</${tag}>`;
  }
  let body='';
  if(input.format==='text' || input.mode==='abstract') body='<div class="plain">'+escape(source)+'</div>';
  else if(input.format==='html') {
    const doc=parse(source); const html=children(doc).find(x=>localName(x)==='html'); const content=children(html??doc).find(x=>localName(x)==='body'); body=emit(content??doc);
    warnings.add('Source HTML layout and scripts are not reproduced; semantic content is reformatted.');
  } else {
    if(/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('Conversion rejects document type and entity declarations.');
    const doc=new DOMParser({onError:level=>{if(level!=='warning') throw Error('Malformed source XML.');}}).parseFromString(source,'text/xml');
    const article=doc.documentElement;
    const sections=children(article).filter(x=>['body','back'].includes(localName(x)));
    const abstracts=Array.from(article.getElementsByTagName('abstract'));
    if(!sections.length && !abstracts.length) throw Error('No supported article body or abstract in source XML.');
    if(!sections.some(x=>localName(x)==='body')) { input={...input,mode:'abstract'}; warnings.add('Saved source has no article body; only available abstract/back matter is shown.'); }
    body=[...abstracts,...sections].map(x=>emit(x)).join('');
  }
  const kind=input.mode==='abstract'?'Abstract Only':'Formatted Reading Copy';
  const note='Generated from saved source; not a publisher original. Source layout is reformatted. Original files remain unchanged. Derived page numbers are not source page numbers.';
  const font=asset('fonts/NotoSansCJKtc-Regular.otf').toString('base64');
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>
@font-face{font-family:Reading;src:url(data:font/otf;base64,${font})} @page{size:A4;margin:18mm 16mm 20mm} body{font-family:Reading,serif;font-size:10pt;line-height:1.5;color:#18242a;overflow-wrap:anywhere}h1{font-size:19pt}h2{font-size:14pt;break-after:avoid}h3{break-after:avoid}p{orphans:3;widows:3}table{width:100%;border-collapse:collapse;font-size:9pt}thead{display:table-header-group}td,th{border:1px solid #789;padding:4px;vertical-align:top}tr{break-inside:avoid}img{max-width:100%;max-height:220mm}figure{margin:12px 0}pre,.plain{white-space:pre-wrap}math{font-family:serif}a{color:#165d7b}.notice,.missing{border-left:3px solid #8b6914;padding:8px;background:#fff8e8}.provenance{font-size:8pt} .columns{columns:2;column-gap:7mm}</style></head><body><header><h1>${escape(input.title)}</h1><p>${escape(kind)}</p><p class="provenance">Search ID: ${escape(input.id)} · Input SHA256: ${escape(input.inputHash)} · Converter: semantic-reading/1</p><p class="notice">${note}</p></header>${body}<footer><h2>Conversion coverage</h2><p>${escape([...warnings].join(' ') || 'No missing component was identified in the supported saved structure; this is not a publisher-layout equivalence claim.')}</p></footer></body></html>`;
  return {html,warnings:[...warnings],kind,nodes,images};
}

export function citations(input) {
  if(!['apa','ieee'].includes(input.style) || !Array.isArray(input.items) || input.items.length>1000) throw Error('Choose APA or IEEE with at most 1000 records.');
  const items=Object.fromEntries(input.items.map(x=>[x.id,x]));
  if(Object.keys(items).length!==input.items.length) throw Error('Duplicate citation identity.');
  const style=asset(`assets/${input.style}.csl`).toString('utf8');
  const engine=new CSL.Engine({retrieveLocale:()=>asset('assets/locales-en-US.xml').toString('utf8'),retrieveItem:id=>items[id]},style,'en-US');
  engine.updateItems(input.items.map(x=>x.id));
  const bibliography=engine.makeBibliography();
  const text=bibliography?.[1].map(x=>textOf(parse(x)).trim()) ?? [];
  const citation=input.items.length?engine.makeCitationCluster(input.items.map(x=>({id:x.id}))):'';
  return {processor:'citeproc-js/2.4.63',style:input.style,styleHash:hash(Buffer.from(style)),locale:'en-US',bibliography:text,citation,ids:input.items.map(x=>x.id),entries:bibliography?.[0].entry_ids ?? []};
}

async function main() {
  const chunks=[];let length=0; for await(const chunk of process.stdin){length+=chunk.length;if(length>48*1024*1024)throw Error('Worker input exceeds limit.');chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(input.operation==='citations') return citations(input);
  if(input.operation!=='reading')throw Error('Unknown document operation.');
  const converted=readingHtml(input);
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--disable-background-networking']});
  try {
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});
    let blocked=0;await context.route('**/*',route=>{blocked++;return route.abort();});
    const page=await context.newPage();await page.setContent(converted.html,{waitUntil:'load',timeout:30000});
    await page.evaluate(()=>document.fonts.ready);
    if(await page.evaluate(()=>Array.from(document.images).some(x=>!x.complete || x.naturalWidth===0)))throw Error('Embedded figure could not be decoded; no complete reading copy accepted.');
    const pdf=await page.pdf({format:'A4',printBackground:true,preferCSSPageSize:true,tagged:true,outline:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:8px;width:100%;text-align:center">Derived page <span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
    if(pdf.length>32*1024*1024)throw Error('Reading output exceeds 32 MiB.');
    return {...converted,html:undefined,pdf:pdf.toString('base64'),renderer:`Chromium/${browser.version()};Playwright/1.63.0`,inputHash:input.inputHash,blockedRequests:blocked,fontHash:assetManifest.find(x=>x.path.startsWith('fonts/')).sha256};
  } finally {await browser.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const timer=setTimeout(()=>{process.stderr.write('Document time budget exceeded.');process.exit(2);},90000);
  try{process.stdout.write(JSON.stringify(await main()));}catch{process.stderr.write('Document processing failed; no output accepted.');process.exitCode=1;}finally{clearTimeout(timer);}
}
