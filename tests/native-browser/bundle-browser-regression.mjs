// Actual native PostgreSQL and compiled React; isolated synthetic originals only.
import { showWorkspace } from "../../src/literature-web/scripts/workspace-navigation.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const inputPath=process.env.NATIVE_BROWSER_INPUT;
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const target=process.env.NATIVE_BROWSER_URL, origin=new URL(target);
assert.equal(origin.hostname,'127.0.0.1');assert.equal(input.origin,target);
const seed=input.bundle_seed;assert(seed);const base=`${target}/api/libraries/${seed.library}/plans/${seed.plan}/bundles`;
const manifest=JSON.parse(fs.readFileSync(input.manifest,'utf8'));
assert.equal(manifest.source_revision,input.source_revision);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}});
await context.route('**/*',r=>new URL(r.request().url()).origin===origin.origin?r.continue():r.abort());
const page=await context.newPage();page.setDefaultTimeout(30000);
const checks=[],posts=[],downloads=[],errors=[];const output=path.dirname(inputPath);
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(r.method()==='POST')posts.push({url:r.url(),body:r.postDataJSON()});});
page.on('download',d=>downloads.push(d));
const until=async(fn,msg)=>{const end=Date.now()+40000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(msg);};
const check=async(name,fn)=>{await fn();checks.push({name,pass:true});};
const panel=page.getByRole('region',{name:'Partitioned original downloads',exact:true});
let lastLogin=0,snapshot,document;
const login=async(a=input.accounts[0])=>{
 await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-lastLogin))));
 await page.getByLabel('Login',{exact:true}).fill(a.login);await page.getByLabel('Password',{exact:true}).fill(a.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByLabel('Choose library',{exact:true}).waitFor();lastLogin=Date.now();
};
const openPlan=async()=>{
 await page.getByLabel('Choose library',{exact:true}).selectOption(seed.library);
 await showWorkspace(page, "Research plans");
 await until(async()=>await page.getByLabel('Saved plans',{exact:true}).locator(`option[value="${seed.plan}"]`).count()===1,'saved plan catalog');
 await showWorkspace(page, "Research plans"); await page.getByLabel('Saved plans',{exact:true}).selectOption(seed.plan);
 await panel.waitFor();await until(async()=>await panel.getByRole('button',{name:'Prepare download parts',exact:true}).isEnabled(),'preparation ready');
};
try {
 await page.goto(target);
 await check('pinned-assets-and-schema6-capability',async()=>{
  const info=await(await page.request.get(target+'/service-info')).json();assert.equal(info.bundleDeliveryEnabled,true);
  assert.equal(info.bundleOriginalLimitBytes,128*1024*1024);
  for(const[n,want]of Object.entries(manifest.files).filter(([n])=>n.startsWith('web/'))){const r=await page.request.get(target+'/'+(n==='web/index.html'?'':n.slice(4)));assert.equal(hash(await r.body()),want);}
 });
 await login();await openPlan();
 await check('lost-receipt-explicit-same-UUID-replay-and-complete-scope',async()=>{
  let first=true;await page.route(base,async route=>{if(first&&route.request().method()==='POST'){first=false;const response=await route.fetch();assert.equal(response.status(),200);document=await response.json();snapshot=document.snapshotID;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.continue();});
  await panel.getByRole('button',{name:'Prepare download parts',exact:true}).click();
  await panel.getByRole('button',{name:'Retry same preparation request',exact:true}).click();
  await until(async()=>(await panel.innerText()).includes('2 of 2 parts selected'),'two parts ready');
  const sent=posts.filter(p=>p.url===base);assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
  const list=await(await page.request.get(base)).json();assert.equal(list.total,1);assert.equal(list.items[0].snapshotID,snapshot);
  assert.equal(document.manifest.counts.members,3);assert.equal(document.manifest.counts.includedRecords,2);assert.equal(document.manifest.counts.unresolvedRecords,1);
  assert.deepEqual(document.manifest.items.map(i=>i.searchId),seed.searchIDs);assert.deepEqual(document.parts.flatMap(p=>p.files.map(f=>f.sha256)),seed.originalSHA256);
 });
 await check('manifest-and-selected-sequential-real-device-files',async()=>{
  await panel.getByRole('button',{name:'Deselect all parts',exact:true}).click();assert.equal(await panel.getByRole('button',{name:'Download selected parts',exact:true}).isEnabled(),false);
  await panel.getByRole('button',{name:'Select all parts',exact:true}).click();
  await panel.getByRole('button',{name:'Save bundle manifest',exact:true}).click();await until(()=>downloads.length===1,'manifest download');
  const central=path.join(output,'bundle.download.json');await downloads[0].saveAs(central);
  const started=Date.now();await panel.getByRole('button',{name:'Download selected parts',exact:true}).click();
  await until(()=>downloads.length===3,'two sequential downloads');
  const files=[];for(let n=0;n<2;n++){const file=path.join(output,document.parts[n].filename);await downloads[n+1].saveAs(file);const b=fs.readFileSync(file);assert.equal(b.length,document.parts[n].bytes);assert.equal(hash(b),document.parts[n].sha256);files.push(file);}
  const result=execFileSync(process.platform==='win32'?'python':'python3',['verify-bundle.py',central,...files,'--synthetic','--negative-controls'],{encoding:'utf8',windowsHide:true});
  fs.writeFileSync(path.join(output,'bundle-reader.json'),result);checks.push({name:'actual-device-files',bytes:files.reduce((n,f)=>n+fs.statSync(f).size,0),elapsedMs:Date.now()-started,pass:true});
  await panel.getByText('Unresolved records and source links (1)',{exact:true}).click();assert(await panel.locator('.bundle-reasons a').count()>0);
 });
 await check('authenticated-range-reassembly-and-invalid-validator',async()=>{
  const part=document.parts[0],url=`${base}/${snapshot}/parts/1`,mid=Math.floor(part.bytes/2),etag=`"${part.sha256}"`;
  const a=await page.request.get(url,{headers:{Range:`bytes=0-${mid-1}`,'If-Match':etag}});assert.equal(a.status(),206);
  const b=await page.request.get(url,{headers:{Range:`bytes=${mid}-${part.bytes-1}`,'If-Match':etag}});assert.equal(b.status(),206);
  assert.equal(hash(Buffer.concat([await a.body(),await b.body()])),part.sha256);
  assert.equal((await page.request.get(url,{headers:{Range:'bytes=0-1','If-Match':'"wrong"'}})).status(),412);
 });
 await check('reopen-relogin-GET-only-and-foreign-scope-denial',async()=>{
  const count=posts.filter(p=>p.url===base).length;await page.reload();await openPlan();
  await panel.getByLabel('Saved download snapshots',{exact:true}).selectOption(snapshot);
  await until(async()=>(await panel.innerText()).includes('2 of 2 parts selected'),'snapshot reopened');
  for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`bundle-${width}.png`),fullPage:true});}
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(input.accounts[1]);
  assert.equal((await page.request.get(`${base}/${snapshot}`)).status(),404);assert.equal((await page.request.get(`${base}/${snapshot}/parts/1`)).status(),404);assert(!(await page.locator('body').innerText()).includes(snapshot));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login();await openPlan();await panel.getByLabel('Saved download snapshots',{exact:true}).selectOption(snapshot);
  await until(async()=>(await panel.innerText()).includes('2 of 2 parts selected'),'relogin reopened');assert.equal(posts.filter(p=>p.url===base).length,count);
 });
 assert.equal(posts.filter(p=>/\/(search|batches|plans|continuation)$/.test(p.url)).length,0);
 assert.equal(fs.existsSync(inputPath+'.source-requests')?fs.readFileSync(inputPath+'.source-requests','utf8').trim():'','');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({scope:'SYNTHETIC originals; actual native PostgreSQL/compiled browser/device files',revision:input.source_revision,checks,sourceCalls:0}));
}catch(e){console.error(JSON.stringify({checks,posts,body:await page.locator('body').innerText()}));throw e;}
finally{await context.close();await browser.close();}
