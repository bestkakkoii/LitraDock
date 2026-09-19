import {selectionReady, selectionControl, setSavedCheckbox, readNativeJson} from "./selection-controls.mjs";
// Actual native PostgreSQL/handlers and pinned compiled React; synthetic source only.
import { showWorkspace, openDisclosure } from "../../src/literature-web/scripts/workspace-navigation.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const inputPath=process.env.NATIVE_BROWSER_INPUT;
assert(inputPath);
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const target=process.env.NATIVE_BROWSER_URL;
const origin=new URL(target);
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.equal(input.origin,target);
const manifest=JSON.parse(fs.readFileSync(input.manifest,'utf8'));
assert.equal(manifest.source_revision,input.source_revision);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:850}});
await context.route('**/*',r=>new URL(r.request().url()).origin===origin.origin?r.continue():r.abort());
const page=await context.newPage();page.setDefaultTimeout(20000);
const checks=[],posts=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(r.method()==='POST')posts.push({url:r.url(),body:r.postDataJSON()});});
const check=async(name,fn)=>{await fn();checks.push({name,pass:true});};
const waitMs=Number(process.env.NATIVE_BROWSER_WAIT_MS||30000);
assert(Number.isInteger(waitMs)&&waitMs>=30000&&waitMs<=120000);
const until=async(fn,message)=>{const end=Date.now()+waitMs;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error(message);};
const panel=page.getByRole('region',{name:'Search continuation',exact:true});
const toolbar=page.getByRole('region',{name:'Saved record selection',exact:true});
let library='',run='',lastLogin=0;
const login=async(account=input.accounts[0])=>{
 await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-lastLogin))));
 await page.getByLabel('Login',{exact:true}).fill(account.login);await page.getByLabel('Password',{exact:true}).fill(account.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByLabel('Choose library',{exact:true}).waitFor();lastLogin=Date.now();
};
const detail=()=>readNativeJson(page, `${target}/api/libraries/${library}/runs/${run}?limit=100`);
const sources=()=>fs.existsSync(inputPath+'.source-requests')?fs.readFileSync(inputPath+'.source-requests','utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
try{
 await page.goto(target);
 await check('pinned-assets-and-schema5-capability',async()=>{
  const info=await(await page.request.get(target+'/service-info')).json();assert.equal(info.searchContinuationEnabled,true);assert.equal(info.durableSelectionEnabled,true);assert.equal(info.selectionWriteEnabled,true);assert.equal(info.searchWindowLimit,1000);
  for(const[name,want]of Object.entries(manifest.files).filter(([n])=>n.startsWith('web/'))){const r=await page.request.get(target+'/'+(name==='web/index.html'?'':name.slice(4)));assert.equal(hash(await r.body()),want);}
 });
 await login();await showWorkspace(page, "Libraries"); await page.getByLabel('New library name',{exact:true}).fill('SYNTHETIC continuation browser');await page.getByRole('button',{name:'Create',exact:true}).click();
 await until(async()=>!!await page.getByLabel('Choose library',{exact:true}).inputValue(),'library creation');library=await page.getByLabel('Choose library',{exact:true}).inputValue();
 await check('lost-initial-receipt-same-UUID-one-frozen-run',async()=>{
  let first=true;
  await page.route('**/search',async route=>{if(first&&route.request().method()==='POST'){first=false;const response=await route.fetch();assert.equal(response.status(),200);const body=await response.json();run=body.id;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.continue();});
  await showWorkspace(page, "Search & PDFs"); await page.getByLabel('Search PubMed',{exact:true}).fill('SYNTHETIC_CONTINUATION_25000');await openDisclosure(page, "Search options"); await page.getByLabel('Retrieved limit',{exact:true}).selectOption('100');
  await page.getByRole('button',{name:'Search PubMed',exact:true}).click();await panel.getByRole('button',{name:'Retry same search request',exact:true}).waitFor();
  await panel.getByRole('button',{name:'Retry same search request',exact:true}).click();
  await until(async()=>(await detail()).continuation?.savedCount===100,'first100 persisted');
  await until(async()=>(await toolbar.innerText()).includes('100 selected of 100 saved'),'initial saved default all');
  const sent=posts.filter(p=>p.url.endsWith('/search'));assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);assert.match(sent[0].body.requestID,/^[a-f0-9-]{36}$/);
  const d=await detail();assert.equal(d.run.run_id,run);assert.equal(d.run.total,25000);assert.equal(d.total,100);assert.equal(d.continuation.windowCount,1000);
  assert.equal(d.continuation.processedCount,100);assert(!('RawXml'in d.records[0]));assert.equal(sources().length,2);
  fs.writeFileSync(path.join(path.dirname(inputPath),'initial-page.json'),JSON.stringify(d));
 });
 await check('cancel-held-response-and-resume-same-page-preserves-explicit-deselection',async()=>{
  await openDisclosure(page, /^Search progress and query details/);
  await setSavedCheckbox(page, page.locator('.result-card input[type=checkbox]').first(), false);await until(async()=>(await toolbar.innerText()).includes('99 selected'),'intentional deselection');
  fs.writeFileSync(inputPath+'.metadata-hold','synthetic schedule');
  await panel.getByRole('button',{name:'Retrieve next metadata page',exact:true}).click();
  await until(()=>fs.existsSync(inputPath+'.metadata-entered'),'held actual native source attempt');
  await until(async()=>(await panel.locator('[role=status] strong').innerText())==='running','published running revision before cancellation');
  await until(async()=>await panel.getByRole('button',{name:'Cancel metadata page',exact:true}).isEnabled(),'cancel running enabled');
  await panel.getByRole('button',{name:'Cancel metadata page',exact:true}).click();await panel.getByRole('button',{name:'Confirm metadata cancellation',exact:true}).click();
  await until(async()=>(await detail()).continuation.state==='cancelled','cancel persisted');
  fs.writeFileSync(inputPath+'.metadata-release','release synthetic response');
  await new Promise(r=>setTimeout(r,1000));let d=await detail();assert.equal(d.total,100);assert.equal(d.continuation.processedCount,100);
  await openDisclosure(page, /^Search progress and query details/);
  await until(async()=>await panel.getByRole('button',{name:'Retrieve next metadata page',exact:true}).isEnabled(),'resume ready');
  await panel.getByRole('button',{name:'Retrieve next metadata page',exact:true}).click();
  await until(async()=>(await detail()).continuation.savedCount===200,'second100 saved');
  await until(async()=>(await toolbar.innerText()).includes('199 selected of 200 saved'),'new saved members follow all default while explicit deselection survives');
  d=await detail();assert.equal(d.run.total,25000);assert.equal(d.continuation.windowCount,1000);assert.equal(d.continuation.processedCount,200);
  const second=await(await page.request.get(`${target}/api/libraries/${library}/runs/${run}?limit=100&offset=100`)).json();assert.equal(second.records.length,100);
  assert.equal(new Set([...d.records,...second.records].map(a=>a.SearchId)).size,200);assert.equal(second.records[0].Pmid,'990000101');
  const source=sources();assert.equal(source.length,4);assert.equal(source.filter(s=>s.path.endsWith('/esearch.fcgi')).length,1);assert.equal(source[2].ids,source[3].ids);
  fs.writeFileSync(path.join(path.dirname(inputPath),'continued-page.json'),JSON.stringify(second));
 });
 await check('explicit-page-selection-and-independent-whole-saved-run-CSV',async()=>{
  const visible=await page.locator('.result-card').count();await selectionControl(page, 'Select page');
  await until(async()=>(await toolbar.innerText()).includes('200 selected of 200 saved'),'page addition restores only that page exception');
  const sourceBefore=sources().length;
  await openDisclosure(page, "Export saved results and other actions");
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Export saved CSV',exact:true}).click();const download=await downloadEvent;
  const file=path.join(path.dirname(inputPath),'continued-run.csv');await download.saveAs(file);const raw=fs.readFileSync(file);const text=raw.toString('utf8');assert(text.includes('Search ID'));assert(text.includes('990000001'));assert(text.includes('990000101'));
  const parsed=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',"import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1],encoding='utf-8-sig',newline='')))))",file],{encoding:'utf8',windowsHide:true}));
  assert.equal(parsed.length,200);assert.equal(new Set(parsed.map(r=>r['Search ID'])).size,200);assert(parsed.every(r=>r.Title.includes('中文')));assert.deepEqual(parsed.map(r=>r.PMID).sort(),Array.from({length:200},(_,i)=>String(990000001+i)).sort());
  assert.deepEqual(posts.filter(p=>p.url.endsWith('/exports')).at(-1).body,{runID:run,format:'csv'});
  assert.equal(sources().length,sourceBefore);checks.push({name:'actual-CSV-device-file',bytes:raw.length,sha256:hash(raw),pass:true});
 });
 await check('reopen-relogin-foreign-scope-and390-layout',async()=>{
  const before=posts.filter(p=>/\/(search|continuation|plans|batches)$/.test(p.url)).length;const sourceBefore=sources().length;
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.reload();await page.getByLabel('Choose library',{exact:true}).selectOption(library);
  await showWorkspace(page, "Saved searches"); await page.getByRole('list',{name:'Saved searches',exact:true}).getByRole('button').filter({hasText:'SYNTHETIC_CONTINUATION_25000'}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
  await until(async()=>(await toolbar.innerText()).includes('200 selected of 200 saved'),'saved run reopen');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(input.accounts[1]);
  assert.equal((await page.request.get(`${target}/api/libraries/${library}/runs/${run}`)).status(),404);assert(!(await page.locator('body').innerText()).includes(run));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login();await page.getByLabel('Choose library',{exact:true}).selectOption(library);
  await showWorkspace(page, "Saved searches"); await page.getByRole('list',{name:'Saved searches',exact:true}).getByRole('button').filter({hasText:'SYNTHETIC_CONTINUATION_25000'}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
  await until(async()=>(await toolbar.innerText()).includes('200 selected of 200 saved'),'relogin reopen');
  assert.equal(posts.filter(p=>/\/(search|continuation|plans|batches)$/.test(p.url)).length,before);assert.equal(sources().length,sourceBefore);
 });
 assert.deepEqual(errors,[]);console.log(JSON.stringify({scope:'SYNTHETIC provider transport; actual native PostgreSQL and compiled React; no genuine-source claim',revision:input.source_revision,checks,providerTotal:25000,window:1000,saved:200,sourceCalls:sources().length}));
}catch(e){console.error(JSON.stringify({checks,posts,body:await page.locator('body').innerText()}));throw e;}
finally{fs.writeFileSync(inputPath+'.metadata-release','finally');await context.close();await browser.close();}
