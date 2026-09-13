import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { unzipSync } from "fflate";

const inputText = process.env.NATIVE_BROWSER_INPUT;
const target = process.env.NATIVE_BROWSER_URL;
if (!inputText || !target) {
  throw new Error("NATIVE_BROWSER_URL and NATIVE_BROWSER_INPUT are required; no native server was tested");
}
const input = inputText.trimStart().startsWith("{")
  ? JSON.parse(inputText)
  : JSON.parse(fs.readFileSync(path.resolve(inputText.trim()), "utf8"));
const origin = new URL(target);
assert.equal(origin.protocol, "http:", "native browser target must use loopback HTTP");
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "native browser target must be loopback");
assert.equal(origin.username, "", "userinfo is forbidden");
assert.equal(origin.password, "", "userinfo is forbidden");
assert.equal(origin.pathname, "/", "target path is forbidden");
assert.equal(origin.search, "", "target query is forbidden");
assert.equal(origin.hash, "", "target fragment is forbidden");
assert.equal(input.origin, target, "input origin must exactly match NATIVE_BROWSER_URL");
assert(Array.isArray(input.accounts) && input.accounts.length === 2 && input.accounts[0].login !== input.accounts[1].login, "two distinct test accounts required");
assert(typeof input.source_revision === "string" && input.source_revision.length > 0, "source_revision is required");
assert(typeof input.manifest === "string", "manifest path is required");
const manifestPath = path.resolve(input.manifest);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.source_revision, input.source_revision, "served manifest/source revision mismatch");
if (manifest.origin !== undefined) assert.equal(manifest.origin, input.origin, "served manifest/origin mismatch");
assert(/^[0-9a-f]{40}$/.test(input.source_revision), "source_revision must be exact 40-hex revision");
const webFiles = Object.entries(manifest.files ?? {}).filter(([name]) => name.startsWith("web/"));
assert(webFiles.some(([name]) => name === "web/index.html"), "runtime manifest must contain compiled web/index.html");
assert(webFiles.filter(([name]) => name.startsWith("web/assets/")).length >= 2, "runtime manifest must contain compiled assets");
assert(Array.isArray(input.originals), "originals receipt is required");
const expectedOriginals = new Map(input.originals.map((x) => [String(x.pmid), x]));
assert.equal(expectedOriginals.size, 2, 'Two exact permitted originals required');
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const checks = [];
const check = async (name, fn) => { await fn(); checks.push({ name, pass: true }); };

const browser = await chromium.launch({ headless: true, ...(process.env.NATIVE_BROWSER_EXECUTABLE ? { executablePath: process.env.NATIVE_BROWSER_EXECUTABLE } : {}) });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 720 } });
await context.route("**/*", (route) => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.origin === origin.origin) return route.continue();
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
// The initial anonymous session probe intentionally returns401. Page exceptions remain fatal;
// consequential application HTTP statuses are checked explicitly below.
const account = input.accounts[0];
let capturedRunId = "";
let capturedBatchId = "";
let libraryId = '', searchPosts = 0, batchPosts = 0;
page.on('request', r => { if(r.method()==='POST' && r.url().endsWith('/search')) searchPosts++; if(r.method()==='POST' && r.url().endsWith('/batches')) batchPosts++; });
const until = async (predicate, reason) => { const end=Date.now()+20000; while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,150));}throw Error(reason); };
let lastLoginCompleted = 0;
const verifyXlsx = async (label, selection) => {
  const detailResponse = await page.request.get(`${target}/api/libraries/${libraryId}/batches/${selection}`, { maxRedirects: 0 });
  assert.equal(detailResponse.status(), 200);
  const detail = await detailResponse.json();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const file = await download;
  assert(file.suggestedFilename().endsWith('.xlsx'));
  const cells = {}, hyperlinks = {};
  const columns = ['SearchId','Title','Authors','Year','Pmid','Pmcid','Doi','OriginalUri','PmcUri','DoiUri'];
  const rowKeys = ['state','reason','rights_uri','original_hash','source_uri','repository_stamp','format','version','bytes'];
  detail.items.forEach((item, i) => {
    const values = [...columns.map(k => String(item.article[k] ?? '')), ...rowKeys.map(k => String(item[k] ?? '')), '', selection, String(item.article.DoiLinkState ?? '')];
    values.forEach((v, column) => { const coordinate=String.fromCharCode(65+column)+(i+2);cells[coordinate]=v;
      if ([7,8,9,12,14].includes(column) && v) { const u=new URL(v); if(u.protocol==='https:' && ['pubmed.ncbi.nlm.nih.gov','pmc.ncbi.nlm.nih.gov','doi.org','creativecommons.org'].includes(u.hostname) && !u.username && !u.password && !u.port && !u.hash) hyperlinks[coordinate]=v; }
    });
  });
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'native-workbook-'));
  try {
    const expected=path.join(temporary,'expected.json');fs.writeFileSync(expected,JSON.stringify({rows:detail.items.length+1,cells,hyperlinks}));
    const result=execFileSync(process.env.NATIVE_WORKBOOK_PYTHON || 'python3',[fileURLToPath(new URL('./verify-workbook.py',import.meta.url)),await file.path(),'--expected',expected],{encoding:'utf8'});
    assert.equal(JSON.parse(result).rows,detail.items.length);
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
};
const login = async (credentials = account) => {
  // Production intentionally holds the single login gate for one second after completion.
  await new Promise(r => setTimeout(r, Math.max(0, 1100 - (Date.now() - lastLoginCompleted))));
  await page.getByLabel("Login", { exact: true }).fill(credentials.login);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Choose library", { exact: true }).waitFor();
  lastLoginCompleted = Date.now();
};

// All records and transport in this suite are explicitly synthetic. Production
// handlers, PostgreSQL, compiled React, downloads and transactions are real.
let planID = '', selected = [], planPosts = [], controls = [];
page.on('request', r => {
  if (r.method() !== 'POST') return;
  if (/\/plans$/.test(r.url())) planPosts.push(r.postDataJSON());
  if (/\/plans\/[^/]+\/control$/.test(r.url())) controls.push(r.postDataJSON());
});
const plans = page.getByRole('region', {name:'Processing plans', exact:true});
const getPlan = async () => {
  const response=await page.request.get(`${target}/api/libraries/${libraryId}/plans/${planID}?limit=100`);
  assert.equal(response.status(),200);return response.json();
};
try {
  await page.goto(target);
  await check('compiled-source-binding', async()=>{
    const info=await (await page.request.get(target+'/service-info')).json();
    assert.equal(info.planEnabled,true);assert.equal(info.planSelectionLimit,100);
    assert.equal(info.source,`https://github.com/bestkakkoii/LitraDock/tree/${input.source_revision}`);
    for(const [name,want] of webFiles){const r=await page.request.get(target+'/'+(name==='web/index.html'?'':name.slice(4)));assert.equal(r.status(),200);assert.equal(hash(await r.body()),want);}
  });
  await login();
  await page.getByLabel('New library name',{exact:true}).fill('SYNTHETIC native plans');
  await page.getByRole('button',{name:'Create',exact:true}).click();
  await until(async()=>!!await page.getByLabel('Choose library',{exact:true}).inputValue(),'library creation');
  libraryId=await page.getByLabel('Choose library',{exact:true}).inputValue();
  await check('100-saved-versus-25001-total-37-cross-page',async()=>{
    await page.getByLabel('Retrieved limit',{exact:true}).selectOption('100');
    await page.getByLabel('Query',{exact:true}).fill('SYNTHETIC_PLAN_25001');
    await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
    await until(async()=>(await page.locator('body').innerText()).includes('retrieved 100 of 25001'),'100 of25001 distinction');
    capturedRunId=await page.getByLabel('Saved searches',{exact:true}).inputValue();
    const r=await (await page.request.get(`${target}/api/libraries/${libraryId}/runs/${capturedRunId}?limit=100`)).json();
    assert.equal(r.total,100);assert.equal(r.run.total,25001);selected=r.records.slice(0,37).map(x=>x.SearchId);assert.equal(new Set(selected).size,37);
    await page.getByLabel('Page size',{exact:true}).selectOption('25');
    const boxes=page.locator('input[type="checkbox"][aria-label^="Select "]');
    await until(async()=>await boxes.count()===25,'25 saved records per page');
    for(const box of await boxes.all())await box.check();
    await page.getByRole('button',{name:'Next records',exact:true}).click();
    await until(async()=>(await page.locator('body').innerText()).includes('showing 26–50'),'second saved page');
    for(const box of (await boxes.all()).slice(0,12))await box.check();
    assert(await page.getByRole('button',{name:'Create batch (37/10)',exact:true}).isDisabled());
    assert(await plans.getByRole('button',{name:'Create processing plan (37/100)',exact:true}).isEnabled());
  });
  await check('lost-admission-reply-same-request-single-plan',async()=>{
    const endpoint=target+`/api/libraries/${libraryId}/plans`;
    let lost=false;
    await page.route(endpoint,async route=>{
      if(route.request().method()!=='POST'||lost)return route.continue();
      lost=true;const response=await route.fetch();assert.equal(response.status(),200);planID=(await response.json()).planID;await route.abort('failed');
    });
    await plans.getByRole('button',{name:'Create processing plan (37/100)',exact:true}).click();
    await plans.getByRole('button',{name:'Retry same submission',exact:true}).waitFor();
    await plans.getByRole('button',{name:'Retry same submission',exact:true}).click();
    await plans.getByRole('heading',{name:'Plan '+planID,exact:true}).waitFor();
    await page.unroute(endpoint);
    assert.equal(planPosts.length,2);assert.deepEqual(planPosts[0],planPosts[1]);assert.deepEqual(planPosts[0].searchIDs,selected);
    const catalog=await (await page.request.get(endpoint)).json();assert.equal(catalog.total,1);
    assert.equal(batchPosts,0,'browser must not create child batches');
  });
  await check('pause-resume-truthful-phases-and-completion',async()=>{
    await until(async()=>(await getPlan()).plan.counts.running===1,'actual provider body gate reached');
    await plans.getByRole('button',{name:'Refresh plan',exact:true}).click();
    await until(async()=>await plans.getByRole('button',{name:'Pause plan',exact:true}).isEnabled(),'pause available');
    await plans.getByRole('button',{name:'Pause plan',exact:true}).click();
    await until(async()=>(await getPlan()).plan.state==='paused','pause committed');
    await until(async()=>await plans.getByRole('button',{name:'Resume plan',exact:true}).isEnabled(),'resume after currentGET');
    let p=await getPlan();assert.equal(Object.values(p.plan.counts).reduce((a,b)=>a+b,0),37);assert(p.plan.counts.paused>0);
    await plans.getByRole('button',{name:'Resume plan',exact:true}).click();
    assert(typeof input.source_gate==='string' && input.source_gate.endsWith('.source-release'));
    fs.writeFileSync(input.source_gate,'SYNTHETIC transport gate release');
    const end=Date.now()+100000;
    while(Date.now()<end){p=await getPlan();if(p.plan.state==='partial')break;await new Promise(r=>setTimeout(r,700));}
    assert.equal(p.plan.state,'partial');assert.equal(p.plan.counts.completed,2);assert.equal(p.plan.counts.held,35);assert.equal(p.plan.counts.retry,0);
    assert.equal(p.items.length,37);assert.deepEqual(p.items.map(x=>x.searchID),selected);
    assert.equal(new Set(p.items.map(x=>x.childBatchID)).size,4);assert.equal(p.plan.admission.admittedCount,37);
    await plans.getByRole('button',{name:'Refresh plan',exact:true}).click();
    await until(async()=>(await plans.innerText()).includes('35'),'confirmed held count');
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'responsive document overflow');
    }
    await page.setViewportSize({width:1280,height:900});
  });
  await check('child-ownership-controls-and-exact-downloads',async()=>{
    const p=await getPlan();const child=p.items.find(x=>x.downloadAvailable).childBatchID;
    await plans.getByRole('button',{name:'Open child batch '+child,exact:true}).first().click();
    await page.getByRole('heading',{name:'Batch '+child,exact:true}).waitFor();capturedBatchId=child;
    for(const name of ['Pause','Resume','Retry eligible','Cancel'])assert(await page.getByRole('button',{name,exact:true}).isDisabled());
    const saves=page.getByRole('button',{name:'Save XML',exact:true});assert.equal(await saves.count(),2);
    const seen=new Set();
    for(const button of await saves.all()){
      const pending=page.waitForEvent('download');await button.click();const bytes=await fs.promises.readFile(await (await pending).path());
      const id=bytes.toString().match(/pub-id-type="pmid">([^<]+)<\/article-id>/)?.[1];const expected=expectedOriginals.get(id);
      assert(expected&&!seen.has(id));seen.add(id);assert.equal(hash(bytes),expected.sha256);assert.equal(bytes.length,expected.bytes);
    }
    assert.equal(seen.size,2);
    await verifyXlsx('Export batch XLSX',child);
    const csvWait=page.waitForEvent('download');await page.getByRole('button',{name:'Export batch CSV',exact:true}).click();const csv=await fs.promises.readFile(await(await csvWait).path());
    const zipWait=page.waitForEvent('download');await page.getByRole('button',{name:'Download original bundle',exact:true}).click();const zip=unzipSync(await fs.promises.readFile(await(await zipWait).path()));
    assert.equal(Buffer.compare(csv,Buffer.from(zip['records.csv'])),0);
    const m=JSON.parse(Buffer.from(zip['manifest.json']).toString());assert.equal(m.items.length,10);
    assert.equal(m.items.filter(x=>x.file).length,2);assert.equal(m.items.filter(x=>!x.file&&x.reason&&x.sourceLinks.length).length,8);
    for(const item of m.items.filter(x=>x.file)){assert.equal(hash(zip[item.file]),expectedOriginals.get(String(item.pmid)).sha256);}
    assert.equal(batchPosts,0);assert.equal(planPosts.length,2);
  });
  await check('relogin-reopen-get-only-and-tenant-denials',async()=>{
    const mutations=JSON.stringify({planPosts,controls,searchPosts,batchPosts});
    await page.reload();await page.getByLabel('Choose library',{exact:true}).waitFor();
    await page.getByLabel('Choose library',{exact:true}).selectOption(libraryId);
    await page.getByLabel('Saved plans',{exact:true}).selectOption(planID);
    await plans.getByRole('heading',{name:'Plan '+planID,exact:true}).waitFor();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Login',{exact:true}).waitFor();
    await login(input.accounts[1]);
    const denied=await page.request.get(`${target}/api/libraries/${libraryId}/plans/${planID}`);assert.equal(denied.status(),404);
    assert.equal(await plans.count(),0);assert(!(await page.locator('body').innerText()).includes(planID));
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Login',{exact:true}).waitFor();
    await login();await page.getByLabel('Choose library',{exact:true}).selectOption(libraryId);
    await page.getByLabel('Saved plans',{exact:true}).selectOption(planID);
    await plans.getByRole('heading',{name:'Plan '+planID,exact:true}).waitFor();
    assert.equal(JSON.stringify({planPosts,controls,searchPosts,batchPosts}),mutations);
  });
  assert.deepEqual(runtimeErrors,[]);
  console.log(JSON.stringify({scope:'Actual native Go/PostgreSQL/compiled React; isolated synthetic transport only',source_revision:input.source_revision,checks,selected:37,providerTotal:25001,retrieved:100,children:4,originals:2,held:35,planPostAttempts:planPosts.length,childPostAttempts:batchPosts}));
} catch(error) {console.error(JSON.stringify({scope:'SYNTHETIC diagnostics only',checks,controls,body:await page.locator('body').innerText()}));throw error;} finally {await context.close();await browser.close();}
