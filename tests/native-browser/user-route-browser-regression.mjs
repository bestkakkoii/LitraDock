// Actual compiled application/native PostgreSQL; every provider response is SYNTHETIC and intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {showWorkspace,openDisclosure} from '../../src/literature-web/scripts/workspace-navigation.mjs';
import {readNativeJson,setSavedCheckbox} from './selection-controls.mjs';
const inputPath=process.env.NATIVE_BROWSER_INPUT;
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const origin=new URL(process.env.NATIVE_BROWSER_URL);
assert.equal(origin.hostname,'127.0.0.1');assert.equal(input.origin,origin.origin);
const output=path.dirname(inputPath),checks=[],requests=[],appBodies=[],errors=[],forbidden=[],httpFailures=[],applicationRecoveries=[];
const key='SYNTHETIC_INVALID_PERSONAL_KEY_059';
const browser=await chromium.launch({headless:true});
const contexts=[];
let held=null,releaseHeld=null;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const until=async(fn,message)=>{const end=Date.now()+90000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,1500));}throw Error(message);};
const syntheticXML=ids=>'<PubmedArticleSet>'+ids.map(id=>`<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><Journal><Title>SYNTHETIC Journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal><ArticleTitle>SYNTHETIC browser 中文 ${id}</ArticleTitle><Abstract><AbstractText>Never a live result.</AbstractText></Abstract></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.0000/synthetic${id}</ArticleId><ArticleId IdType="pmc">PMC${id}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`).join('')+'</PubmedArticleSet>';
async function context(){
 const c=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:850}});contexts.push(c);
 await c.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===origin.origin){if(request.method()==='POST')appBodies.push(request.postData()??'');return route.continue();}
  if(url.origin!=='https://eutils.ncbi.nlm.nih.gov'||!['/entrez/eutils/esearch.fcgi','/entrez/eutils/efetch.fcgi'].includes(url.pathname)){forbidden.push(url.origin);return route.abort();}
  assert.equal(request.method(),'POST');assert.equal(request.resourceType(),'fetch');
  const headers=await request.allHeaders();assert(!headers.cookie);assert(!headers['x-csrf']);assert(!headers.authorization);assert(!headers.referer);
  const body=new URLSearchParams(request.postData());assert.equal(body.get('db'),'pubmed');assert.equal(body.get('retmode'),'xml');
  const entry={path:url.pathname,at:Date.now(),term:body.get('term'),ids:body.get('id'),keyPresent:body.has('api_key'),origin:headers.origin??null};requests.push(entry);
  if(body.has('api_key')) {assert.equal(body.get('api_key'),key);return route.fulfill({status:403,contentType:'application/json',body:'{"error":"SYNTHETIC revoked key"}',headers:{'Access-Control-Allow-Origin':'*'}});}
  if(body.get('term')?.includes('OFFLINE'))return route.abort('internetdisconnected');
  if(body.get('term')?.includes('RATE'))return route.fulfill({status:429,body:'SYNTHETIC shared network limited',headers:{'Access-Control-Allow-Origin':'*','Retry-After':'60'}});
  let xml;
  if(url.pathname.endsWith('esearch.fcgi')){
   assert.equal(body.get('sort'),'relevance');assert.equal(body.get('retmax'),'1000');assert.equal(body.get('retstart'),'0');
   const first=body.get('term')?.includes('LOST')?'990000011':body.get('term')?.includes('CANCEL')?'990000021':'990000001';
   const ids=[first,String(Number(first)+1)];
   xml=`<eSearchResult><Count>2</Count><IdList>${ids.map(id=>`<Id>${id}</Id>`).join('')}</IdList><QueryTranslation>${body.get('term')}</QueryTranslation></eSearchResult>`;
  }else{
   const ids=body.get('id').split(',');assert(ids.every(id=>/^9900000[0-9]{2}$/.test(id)));
   if(ids.includes('990000021')&&!held){held=new Promise(resolve=>{releaseHeld=resolve;});await held;}
   xml=syntheticXML(ids);
  }
  return route.fulfill({status:200,contentType:'text/xml; charset=utf-8',body:xml,headers:{'Access-Control-Allow-Origin':'*'}}).catch(()=>{});
 });
 c.on('page',p=>{p.setDefaultTimeout(90000);p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400)httpFailures.push({path:new URL(r.url()).pathname,status:r.status()});});});
 return c;
}
async function login(page,account){await page.goto(origin.origin);await page.getByLabel('Login',{exact:true}).fill(account.login);await page.getByLabel('Password',{exact:true}).fill(account.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByLabel('Choose library',{exact:true}).waitFor();}
async function library(page,label){await showWorkspace(page,'Libraries');await page.getByLabel('New library name',{exact:true}).fill(label);await page.getByRole('button',{name:'Create',exact:true}).click();await until(async()=>!!await page.getByLabel('Choose library',{exact:true}).inputValue(),'library created');return page.getByLabel('Choose library',{exact:true}).inputValue();}
async function search(page,query){
 await showWorkspace(page,'Search & PDFs');await page.getByLabel('Search PubMed',{exact:true}).fill(query);
 const receipt=page.waitForResponse(r=>new URL(r.url()).origin===origin.origin&&r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/search'));
 await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
 let response=await receipt;const original=response.request().postData();
 for(let retry=0;response.status()===429&&retry<2;retry++){
  assert.equal((await response.json()).code,'admission_not_started');assert.equal(response.headers()['retry-after'],'2');
  await openDisclosure(page,/^Search progress and query details/);await page.waitForTimeout(2000);
  const again=page.waitForResponse(r=>new URL(r.url()).origin===origin.origin&&r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/search'));
  await progress(page).getByRole('button',{name:'Retry same search request',exact:true}).click();response=await again;
  assert.equal(response.request().postData(),original,'application admission recovery must retain the same UUID and query');
  applicationRecoveries.push({kind:'same_search_admission',query,status:response.status()});
 }
 assert.equal(response.status(),200);const result=await response.json();assert.match(result.id,/^RUN-[0-9a-f]{32}$/);return result.id;
}
const detail=(page,lib,run)=>readNativeJson(page,`${origin.origin}/api/libraries/${lib}/runs/${run}?limit=100`);
const progress=page=>page.getByRole('region',{name:'Search continuation',exact:true});
async function check(name,fn){console.log(JSON.stringify({started:name}));await fn();checks.push({name,pass:true});console.log(JSON.stringify({passed:name}));}
let page,lib,run;
try{
 const c=await context();page=await c.newPage();await login(page,input.accounts[0]);lib=await library(page,'SYNTHETIC user-origin');
 await check('effective-CSP-supported-browser-and-real-native-service',async()=>{
  const response=await page.request.get(origin.origin+'/service-info');assert.equal((await response.json()).userRouteEnabled,true);
  assert(response.headers()['content-security-policy'].includes("connect-src 'self' https://eutils.ncbi.nlm.nih.gov"));
  assert(await page.evaluate(()=>isSecureContext&&!!navigator.locks&&!!AbortSignal.any));
 });
 await check('browser-POST-search-metadata-selection-provenance-and-device-export',async()=>{
  run=await search(page,'SYNTHETIC USER ROUTE[Title] AND 2020:2026[dp]');
  await until(async()=>await page.locator('.result-card').count()===2,'rendered source records');
  const saved=await detail(page,lib,run);assert.equal(saved.run.total,2);assert.equal(saved.continuation.execution,'user_browser');assert(saved.records.every(a=>a.MetadataVerification==='client_submitted_parsed'));assert.equal(requests.length,2);
  await setSavedCheckbox(page,page.locator('.result-card input[type=checkbox]').first(),false);
  await until(async()=>(await page.getByRole('region',{name:'Saved record selection'}).innerText()).includes('1 selected of 2 saved'),'saved selection');
  await openDisclosure(page,'Export saved results and other actions');const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export saved CSV',exact:true}).click();
  const file=path.join(output,'user-route-saved.csv');await(await download).saveAs(file);const csv=fs.readFileSync(file);assert(csv.includes('client_submitted_parsed'));assert(csv.includes('990000001'));assert(csv.includes('中文'));assert.equal(requests.length,2);
  checks.push({name:'actual CSV bytes',sha256:hash(csv),bytes:csv.length,pass:true});
  await page.screenshot({path:path.join(output,'user-route-1280.png'),fullPage:true});
 });
 await check('lost-upload-response-reconciles-only-application-request',async()=>{
  let dropped=false;const bodies=[];
  await page.route('**/user-route/upload',async route=>{
   bodies.push(route.request().postData());
   if(!dropped&&JSON.parse(route.request().postData()).body){dropped=true;const r=await route.fetch();assert.equal(r.status(),200);return route.fulfill({status:503,body:'SYNTHETIC lost reply'});}
   return route.continue();
  });
  const before=requests.length;await search(page,'SYNTHETIC LOST');
  await openDisclosure(page,/^Search progress and query details/);
  await progress(page).getByRole('button',{name:'Retry saving results',exact:true}).click();
  await until(async()=>!await progress(page).getByRole('button',{name:'Retry saving results',exact:true}).count(),'receipt reconciled');
  assert.equal(requests.length,before+1);assert.equal(bodies[0],bodies[1]);
  await page.unroute('**/user-route/upload');
  await progress(page).getByRole('button',{name:'Resume in this browser',exact:true}).click();
  await until(async()=>await page.locator('.result-card').count()===2,'explicit metadata after reconciliation');
  assert.equal(requests.length,before+2);
 });
 await check('revoked-personal-key-has-no-leak-fallback-or-global-outage',async()=>{
  await openDisclosure(page,/^PubMed access/);await page.getByLabel('Personal NCBI API key',{exact:true}).fill(key);await page.getByRole('button',{name:'Use personal key',exact:true}).click();
  const before=requests.length;const invalidRun=await search(page,'SYNTHETIC INVALID KEY');
  await until(async()=>(await detail(page,lib,invalidRun)).continuation.state==='expired','rejection saved');
  assert.equal(requests.length,before+1);assert.equal(requests.at(-1).keyPresent,true);assert(appBodies.every(b=>!b.includes(key)));
  assert(!(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(key));
  await openDisclosure(page,/^PubMed access/);await page.getByRole('button',{name:'Remove personal key',exact:true}).click();
  const otherContext=await context(),otherPage=await otherContext.newPage();await login(otherPage,input.accounts[1]);const otherLib=await library(otherPage,'SYNTHETIC independent user');
  const otherRun=await search(otherPage,'SYNTHETIC OTHER USER');await until(async()=>(await detail(otherPage,otherLib,otherRun)).run.fetched===2,'independent user unaffected');
  assert.equal((await otherPage.request.get(`${origin.origin}/api/libraries/${lib}/runs/${run}`)).status(),404);
 });
 await check('real-Web-Locks-cross-tab-spacing-and-cancellation',async()=>{
  const active=contexts[1].pages()[0],otherLib=await active.getByLabel('Choose library',{exact:true}).inputValue();
  const tab=await contexts[1].newPage();let busySession=true;
  await tab.route('**/api/session',route=>{
   if(busySession){busySession=false;return route.fulfill({status:429,contentType:'application/json',body:'{"code":"admission_not_started"}',headers:{'Retry-After':'2'}});}
   return route.continue();
  });
  const beforeSession=requests.length;await tab.goto(origin.origin);
  await tab.getByRole('button',{name:'Check sign-in again',exact:true}).waitFor();await tab.waitForTimeout(2000);
  await tab.getByRole('button',{name:'Check sign-in again',exact:true}).click();
  await tab.getByLabel('Choose library',{exact:true}).selectOption(otherLib);
  await Promise.all([active.waitForLoadState('networkidle'),tab.waitForLoadState('networkidle')]);
  assert.equal(requests.length,beforeSession,'session recovery must not send provider requests');
  const before=requests.length;
  await Promise.all([search(active,'SYNTHETIC TAB ONE'),search(tab,'SYNTHETIC TAB TWO')]);
  await Promise.all([openDisclosure(active,/^Search progress and query details/),openDisclosure(tab,/^Search progress and query details/)]);
  let recoveryActions=0;
  await until(async()=>{
   if(requests.length===before+4&&await active.locator('.result-card').count()===2&&await tab.locator('.result-card').count()===2)return true;
   // Concurrent tabs share the deliberately small application admission cap.
   // Exercise explicit offered recovery controls; never repeat a source request
   // or bypass a server limit through direct test-only POSTs.
   for(const target of [active,tab])for(const name of ['Retry saving results','Resume in this browser']){
    const control=progress(target).getByRole('button',{name,exact:true});
    if(await control.isVisible()&&await control.isEnabled()){
     assert(++recoveryActions<=8,'bounded explicit application recovery');await target.waitForTimeout(2000);await control.click();
     applicationRecoveries.push({kind:name});
    }
   }
   return false;
  },'both real tabs saved results');
  const samples=requests.slice(before);for(let i=1;i<samples.length;i++)assert(samples[i].at-samples[i-1].at>=1190,'actual source calls respected profile pacing');
  await tab.close();
  // Cancel the actual compiled controller's held source response.
  const cancelledRun=await search(active,'SYNTHETIC CANCEL');await until(()=>!!held,'metadata held');
  await openDisclosure(active,/^Search progress and query details/);await progress(active).getByRole('button',{name:'Stop browser request',exact:true}).click();
  await until(async()=>(await detail(active,otherLib,cancelledRun)).continuation.state==='cancelled','cancel saved');releaseHeld();
  assert.equal((await detail(active,otherLib,cancelledRun)).run.fetched,0);
 });
 await check('offline-and-shared-network429-remain-local-failures',async()=>{
  for(const word of ['OFFLINE','RATE']){
   const faultContext=await context(),faultPage=await faultContext.newPage();await login(faultPage,input.accounts[0]);const faultLib=await library(faultPage,'SYNTHETIC '+word);
   const before=requests.length;const id=await search(faultPage,'SYNTHETIC '+word);
   await until(async()=>(await detail(faultPage,faultLib,id)).continuation.state==='expired','fault saved');
   const saved=await detail(faultPage,faultLib,id);assert.equal(saved.run.fetched,0);assert.equal(requests.length,before+1);
   if(word==='OFFLINE')assert(saved.run.reason.includes('does not establish a provider-wide outage'));
   else assert(saved.run.reason.includes('institution network or key'));
   await faultPage.close();
  }
 });
 await check('narrow-reopen-retains-saved-selection-and-uses-no-source',async()=>{
  const before=requests.length;let releaseRestore,restoreStarted;
  const heldRestore=new Promise(resolve=>{releaseRestore=resolve;});
  const startRestore=new Promise(resolve=>{restoreStarted=resolve;});let heldOnce=false;
  await page.route('**/runs/**',async route=>{
   if(!heldOnce&&route.request().method()==='GET'&&/\/runs\/RUN-[0-9a-f]{32}$/.test(new URL(route.request().url()).pathname)){
    heldOnce=true;const response=await route.fetch();assert.equal(response.status(),200);restoreStarted();await heldRestore;return route.fulfill({response});
   }
   return route.continue();
  });
  await page.setViewportSize({width:390,height:844});await page.reload();await page.getByLabel('Choose library',{exact:true}).selectOption(lib);
  await startRestore;await showWorkspace(page,'Saved searches');releaseRestore();
  const savedEntry=page.getByRole('list',{name:'Saved searches',exact:true}).getByRole('button').filter({hasText:'SYNTHETIC USER ROUTE[Title]'});
  await until(async()=>await savedEntry.isEnabled(),'late restore finished without replacing chosen workspace');
  assert.equal(await page.getByRole('navigation',{name:'Workspace',exact:true}).getByRole('button',{name:'Saved searches',exact:true}).getAttribute('aria-current'),'page');
  await page.unroute('**/runs/**');await savedEntry.click();
  await until(async()=>(await page.getByRole('region',{name:'Saved record selection'}).innerText()).includes('1 selected of 2 saved'),'reopen durable choice');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(requests.length,before);
  await page.screenshot({path:path.join(output,'user-route-390.png'),fullPage:true});
 });
 assert.equal(forbidden.length,0);assert.deepEqual(errors,[]);assert(!fs.existsSync(inputPath+'.source-requests'));
 const result={scope:'SYNTHETIC provider responses only; actual Windows/Linux browser runtime is recorded by runner; actual Go/PostgreSQL and compiled React',revision:input.source_revision,browser:browser.version(),checks,requests,applicationRecoveries,serverProviderCalls:0};
 fs.writeFileSync(path.join(output,'user-route-evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({checks,requests,errors,forbidden,httpFailures,pages:await Promise.all(contexts.flatMap(c=>c.pages()).map(async p=>({url:p.url(),body:await p.locator('body').innerText().catch(()=>'<unavailable>')})))}));throw error;}
finally{releaseHeld?.();await Promise.all(contexts.map(c=>c.close()));await browser.close();}
