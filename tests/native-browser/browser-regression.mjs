import {selectionReady, selectionControl, setSavedCheckbox} from "./selection-controls.mjs";
import { showWorkspace, openDisclosure } from "../../src/literature-web/scripts/workspace-navigation.mjs";
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
const savedRunMembers = new Map(); // Independent saved-query membership, captured before each export.
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
    const runIDs = [...savedRunMembers].filter(([, ids]) => ids.has(item.article.SearchId)).map(([id]) => id).sort();
    assert(runIDs.length > 0, 'every fixture item must belong to an independently captured saved run');
    const outcome = item.sourceOutcome;
    assert(['acquired','unavailable'].includes(item.state), 'workbook oracle requires settled fixture items');
    assert.equal(outcome.status, item.state === 'acquired' ? 'ready' : 'restricted');
    assert.equal(outcome.evidence, item.state === 'acquired' ? 'current_original_validation' : 'saved_item_outcome');
    assert.equal(outcome.requestedFormat, 'xml');assert.equal(outcome.retryEligible, false);assert.equal(outcome.observedAt, null);
    const values = [...columns.map(k => String(item.article[k] ?? '')), ...rowKeys.map(k => String(item[k] ?? '')), runIDs.join('; '), selection, String(item.article.DoiLinkState ?? ''), ...['status','detail','nextAction','evidence','observedAt','requestedFormat'].map(k => String(outcome[k] ?? ''))];
    assert.equal(values.length,28);
    values.forEach((v, column) => { const coordinate=(column < 26 ? String.fromCharCode(65+column) : 'A'+String.fromCharCode(65+column-26))+(i+2);cells[coordinate]=v;
      if ([7,8,9,12,14].includes(column) && v) { const u=new URL(v); if(u.protocol==='https:' && ['pubmed.ncbi.nlm.nih.gov','pmc.ncbi.nlm.nih.gov','doi.org','creativecommons.org'].includes(u.hostname) && !u.username && !u.password && !u.port && !u.hash) hyperlinks[coordinate]=v; }
    });
  });
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'native-workbook-'));
  try {
    const expected=path.join(temporary,'expected.json');fs.writeFileSync(expected,JSON.stringify({rows:detail.items.length+1,cells,hyperlinks}));
    const result=execFileSync(process.env.NATIVE_WORKBOOK_PYTHON || 'python3',[fileURLToPath(new URL('./verify-workbook.py',import.meta.url)),await file.path(),'--expected',expected],{encoding:'utf8',windowsHide:true});
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

try {
  await page.goto(origin.origin, { waitUntil: "domcontentloaded" });
  await check("manifest-static-asset-binding", async () => {
    const info=await page.request.get(target+'/service-info',{maxRedirects:0});assert.equal(info.status(),200);assert.equal((await info.json()).source,`https://github.com/bestkakkoii/LitraDock/tree/${input.source_revision}`);
    for (const [name, expectedHash] of webFiles) {
      assert(!name.slice(4).includes("..") && !name.slice(4).startsWith("/"), `unsafe manifest path: ${name}`);
      const assetUrl = new URL(name === 'web/index.html' ? '/' : name.slice(4), origin);
      assert.equal(assetUrl.origin, origin.origin, "manifest asset escaped target origin");
      const response = await page.request.get(assetUrl.href, { maxRedirects: 0 });
      assert.equal(response.status(), 200, `missing compiled asset: ${name}`);
      assert.equal(hash(await response.body()), expectedHash, `compiled asset hash mismatch: ${name}`);
    }
  });
  await check("login-and-library-creation", async () => {
    await login();
    await showWorkspace(page, "Libraries");
    const newLibrary = page.getByLabel("New library name", { exact: true });
    await newLibrary.fill(`native-browser-${Date.now()}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await until(async()=>!!(await page.getByLabel('Choose library',{exact:true}).inputValue()),'new library not selected');
    libraryId=await page.getByLabel('Choose library',{exact:true}).inputValue();
  });
  await check('loading-and-source-error',async()=>{
    await showWorkspace(page, "Search & PDFs"); await page.getByLabel('Search PubMed',{exact:true}).fill('SYNTHETIC_ERROR');
    await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
    await page.getByRole('button',{name:'Working…',exact:true}).waitFor();
    await until(async()=>(await page.locator('body').innerText()).includes('NCBI denied access'),'truthful provider denial absent');
    assert.equal(await page.getByLabel('Search PubMed',{exact:true}).inputValue(),'SYNTHETIC_ERROR','query label must remain stable with populated text');
  });
  await check("search-partial-count-and-reopen", async () => {
    await page.getByLabel("Search PubMed", { exact: true }).fill('"synthetic α" AND PMID:123');
    await page.getByRole("button", { name: "Search PubMed", exact: true }).click();
    await until(async()=>{const text=await page.locator('.compact-result-head').innerText();return text.includes('3 loaded')&&text.includes('25,000 matches');},'truthful partial totals absent');
    await openDisclosure(page, /^Search progress and query details/);
    await showWorkspace(page, "Saved searches");
    await page.locator(".history-entry").first().waitFor();
    await showWorkspace(page, "Search & PDFs");
    capturedRunId = (await page.locator(".query-snapshot .small").innerText()).replace("Search Run ID: ", "");
    assert(capturedRunId, "saved run id must be captured for reopen");
  });
  await check("batch-controls-and-exact-exports", async () => {
    const records = page.locator('input[type="checkbox"][aria-label^="Select "]');
    assert.equal(await records.count(), 3, "synthetic native transport must expose exactly three records");
    for (const record of await records.all()) await setSavedCheckbox(page, record, true);
    await openDisclosure(page, "Export saved results and other actions");
    await page.getByRole("button", { name: /Create batch \(3\/10\)/ }).click();
    await page.getByRole('heading',{name:/^Batch BAT-/}).waitFor();
    capturedBatchId = await page.getByRole("heading", { name: /Batch / }).textContent();
    capturedBatchId = capturedBatchId.trim().split(/\s+/).at(-1);
    assert(capturedBatchId, "saved batch id must be captured for reopen");
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'two completed originals absent');
    for (const label of ["Pause", "Resume", "Retry eligible", "Cancel"]) await page.getByRole("button", { name: label, exact: true }).waitFor();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export batch CSV", exact: true }).click();
    const csv = await download;
    const csvBytes = await fs.promises.readFile(await csv.path());
    for (const column of ["Search ID", "PMID", "PMCID", "DOI", "Original SHA256"]) assert(csvBytes.includes(Buffer.from(column)), `CSV must include ${column}`);
    const zipDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download original bundle", exact: true }).click();
    const zip = await zipDownload;
    const zipBytes = await fs.promises.readFile(await zip.path());
    const entries = unzipSync(zipBytes);
    const crc=bytes=>{let v=0xffffffff;for(const b of bytes){v^=b;for(let k=0;k<8;k++)v=(v>>>1)^((v&1)?0xedb88320:0);}return (v^0xffffffff)>>>0;};
    let central=0;for(let pos=0;pos+46<=zipBytes.length;pos++){if(zipBytes.readUInt32LE(pos)!==0x02014b50)continue;const n=zipBytes.readUInt16LE(pos+28),extra=zipBytes.readUInt16LE(pos+30),comment=zipBytes.readUInt16LE(pos+32);const name=zipBytes.subarray(pos+46,pos+46+n).toString('utf8');assert(entries[name]);assert.equal(crc(entries[name]),zipBytes.readUInt32LE(pos+16));central++;pos+=45+n+extra+comment;}assert.equal(central,4);
    assert.deepEqual(Object.keys(entries).filter((name) => name === "manifest.json" || name === "records.csv").sort(), ["manifest.json", "records.csv"]);
    const zipManifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
    assert.equal(zipManifest.items.length, 3, "ZIP manifest must retain all selected items");
    const originalEntries = Object.keys(entries).filter((name) => name.startsWith("originals/") && name.endsWith(".xml"));
    assert.equal(originalEntries.length, 2, "ZIP must contain exactly two permitted originals");
    assert.equal(zipManifest.items.filter((item) => item.file).length, 2, "held item must have no ZIP file");
    const held=zipManifest.items.find(item=>!item.file);assert.equal(held.pmid,'990000003');assert.match(held.reason,/clarification/);assert(held.sourceLinks.includes('https://pubmed.ncbi.nlm.nih.gov/990000003/'));
    const zipObserved = new Set();
    for (const name of originalEntries) {
      const bytes = Buffer.from(entries[name]);
      const item = zipManifest.items.find((candidate) => candidate.file === name);
      assert(item && item.sha256 && item.bytes, `ZIP manifest must identify ${name}`);
      assert.equal(hash(bytes), item.sha256, `ZIP CRC/hash payload mismatch for ${name}`);
      assert.equal(bytes.length, item.bytes, `ZIP byte count mismatch for ${name}`);
      const expected=expectedOriginals.get(String(item.pmid));assert(expected,'ZIP identity must match independent receipt');
      assert(!zipObserved.has(String(item.pmid)),'ZIP identities must be distinct');zipObserved.add(String(item.pmid));
      assert.equal(hash(bytes),expected.sha256);assert.equal(bytes.length,expected.bytes);
    }
    assert.deepEqual([...zipObserved].sort(),[...expectedOriginals.keys()].sort());
    assert.equal(Buffer.compare(Buffer.from(entries["records.csv"]), csvBytes), 0, "ZIP records.csv must equal CSV export bytes");
  });
  await check('structured-four-device-files-whole-scope-and-no-acquisition', async () => {
    const priorSearch = searchPosts, priorBatch = batchPosts;
    await showWorkspace(page, "Search & PDFs"); await selectionControl(page, 'Deselect all');
    const runResponse = await page.request.get(`${target}/api/libraries/${libraryId}/runs/${capturedRunId}?limit=100`);
    assert.equal(runResponse.status(),200); const saved = await runResponse.json();
    assert.equal(saved.records.length,saved.total);savedRunMembers.set(capturedRunId,new Set(saved.records.map(x=>x.SearchId)));
    const batchResponse = await page.request.get(`${target}/api/libraries/${libraryId}/batches/${capturedBatchId}`);
    assert.equal(batchResponse.status(),200); const batch = await batchResponse.json();
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-structured-'));
    const results={};
    try {
      for (const scope of ['run','batch']) for (const format of ['json','jsonl']) {
        await showWorkspace(page, scope === 'run' ? 'Search & PDFs' : 'Downloads');
        if (scope === 'run') await openDisclosure(page, "Export saved results and other actions");
        const label=scope==='run'?`Export saved run ${format.toUpperCase()}`:`Export batch ${format.toUpperCase()}`;
        const waiting=page.waitForEvent('download'); await page.getByRole('button',{name:label,exact:true}).click();
        const file=await waiting; assert.equal(file.suggestedFilename(),`litradock-research.${format}`);
        const destination=path.join(directory,`${scope}.${format}`);await file.saveAs(destination);
        const parsed=JSON.parse(execFileSync(process.env.NATIVE_STRUCTURED_PYTHON||'python3',[fileURLToPath(new URL('./verify-structured.py',import.meta.url)),destination],{encoding:'utf8',windowsHide:true}));
        assert.deepEqual(parsed.records,[3]);
        const text=fs.readFileSync(destination,'utf8');let d;
        if(format==='json')d=JSON.parse(text);else{const lines=text.trimEnd().split('\n').map(x=>JSON.parse(x));d=lines[0];d.records=lines.slice(1).map(x=>x.record);}
        assert.equal(d.scope.kind,scope);assert.equal(d.scope.runId,scope==='run'?capturedRunId:null);assert.equal(d.scope.batchId,scope==='batch'?capturedBatchId:null);
        assert.equal(d.counts.exportedRecords,3);assert.equal(d.counts.providerMatches,scope==='run'?25000:null);
        assert.equal(d.queryContexts[0].query,saved.run.input);assert.equal(d.queryContexts[0].retrievalComplete,false);
        const oracle=scope==='run'?saved.records:batch.items.map(x=>x.article);
        assert.deepEqual(d.records.map(x=>x.searchId),oracle.map(x=>x.SearchId));
        for(let i=0;i<3;i++) {const record=d.records[i],article=oracle[i];assert.equal(record.publication.title,article.Title);assert.equal(record.identifiers.pmid,article.Pmid);assert.equal(record.identifiers.pmcid,article.Pmcid);assert.equal(record.identifiers.doi,article.Doi);assert.equal(record.publication.abstract,article.Abstract||null);}
        if(scope==='batch'){
          const held=d.records.find(x=>x.acquisition.state==='unavailable');assert(held&&held.acquisition.reason&&held.sourceLinks.pubmed);
          assert.equal(d.records.flatMap(x=>x.originals).length,2);
          for(const r of d.records)for(const o of r.originals){assert.equal(o.sha256,expectedOriginals.get(r.identifiers.pmid).sha256);assert.equal(o.availability,'not_revalidated');}
        }
        results[scope+format]=d.records;
      }
      assert.deepEqual(results.runjson,results.runjsonl);assert.deepEqual(results.batchjson,results.batchjsonl);
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
    assert.equal(searchPosts,priorSearch);assert.equal(batchPosts,priorBatch);
  });
  await check("original-rights-and-fidelity", async () => {
    const saves = page.getByRole("button", { name: "Save XML", exact: true });
    assert.equal(await saves.count(), 2, "exactly two permitted originals must have Save XML actions");
    const observed = new Set();
    for (const save of await saves.all()) {
      const download = page.waitForEvent("download");
      await save.click();
      const item = await download;
      const bytes = await fs.promises.readFile(await item.path());
      const pmid = bytes.toString("utf8").match(/pub-id-type="pmid">([^<]+)<\/article-id>/)?.[1];
      const expected = expectedOriginals.get(pmid);
      assert(expected, `original PMID ${pmid} missing from protected receipt`);
      assert(!observed.has(pmid), 'Save controls must return distinct expected originals');observed.add(pmid);
      assert.equal(hash(bytes), expected.sha256, `original ${pmid} hash mismatch`);
      assert.equal(bytes.length, expected.bytes, `original ${pmid} byte count mismatch`);
    }
    assert.deepEqual([...observed].sort(), [...expectedOriginals.keys()].sort());
    assert(await page.getByText(/unavailable|blocked|denied/i).count() > 0, "held original reason must remain visible");
    assert(await page.getByText(/PDF.*not|publisher.*not|login.*not|not.*publisher/i).count() > 0, "unsupported publisher PDF/login disclaimer must be visible");
  });
  await check('xlsx-independent-reader-batch-bytes-and-provenance', async()=>{ await verifyXlsx('Export batch XLSX', capturedBatchId); });
  await check('saved-record-pages-cap-and-large-synthetic-counts', async()=>{
    await showWorkspace(page, "Search & PDFs"); await openDisclosure(page, "Search options"); await page.getByLabel('Retrieved limit',{exact:true}).selectOption('25');
    for(const total of [1000,10000,25001]) {
      await page.getByLabel('Search PubMed',{exact:true}).fill('SYNTHETIC_PAGES_'+total);
      await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
      await until(async()=>{const text=await page.locator('.compact-result-head').innerText();return text.includes('12 loaded')&&text.includes(`${total.toLocaleString()} matches`);},'synthetic saved/provider count distinction');
      await openDisclosure(page, /^Search progress and query details/);
      assert.equal(await page.locator('input[type="checkbox"][aria-label^="Select "]').count(),12);
      const runID = (await page.locator('.query-snapshot .small').innerText()).replace('Search Run ID: ', '');
      const response = await page.request.get(`${target}/api/libraries/${libraryId}/runs/${runID}?limit=100`);
      assert.equal(response.status(),200);const saved=await response.json();
      assert.equal(saved.records.length,12);assert.equal(saved.total,12);assert.equal(saved.run.total,total);
      savedRunMembers.set(runID,new Set(saved.records.map(x=>x.SearchId)));
    }
    const largeRun = (await page.locator(".query-snapshot .small").innerText()).replace("Search Run ID: ", "");
    for(const limit of ['0','101','bad','']) assert.equal((await page.request.get(`${target}/api/libraries/${libraryId}/runs/${largeRun}?limit=${limit}`)).status(),400);
    const pages=[];for(const offset of [0,5,10]) { const r=await page.request.get(`${target}/api/libraries/${libraryId}/runs/${largeRun}?limit=5&offset=${offset}`);assert.equal(r.status(),200);const d=await r.json();assert.equal(d.limit,5);assert.equal(d.total,12);assert.equal(d.run.total,25001);pages.push(...d.records.map(x=>x.SearchId)); }
    assert.equal(new Set(pages).size,12);
    await page.getByLabel('Page size',{exact:true}).selectOption('5');
    const boxes=page.locator('input[type="checkbox"][aria-label^="Select "]');
    await until(async()=>await boxes.count()===5,'page-size change must reload existing run');
    await selectionControl(page, 'Deselect all');
    for(const box of await boxes.all()) await setSavedCheckbox(page, box, true);
    await page.getByRole('button',{name:'Next records',exact:true}).click();
    await until(async()=>(await page.locator('body').innerText()).includes('6–10 shown'),'second saved page');
    for(const box of await boxes.all()) await setSavedCheckbox(page, box, true);
    await page.getByRole('button',{name:'Next records',exact:true}).click();
    await until(async()=>await boxes.count()===2,'third saved page');
    await setSavedCheckbox(page, boxes.first(), true);
    assert.equal(await boxes.first().isChecked(),true);
    await openDisclosure(page, "Export saved results and other actions");
    assert(await page.getByRole('button',{name:'Create batch (11/10)',exact:true}).isDisabled());
    await setSavedCheckbox(page, boxes.first(), false);
    assert(await page.getByRole('button',{name:'Create batch (10/10)',exact:true}).isEnabled());
    const csrf=(await (await page.request.get(target+'/api/session')).json()).csrf;
    assert.equal((await page.request.post(`${target}/api/libraries/${libraryId}/batches`,{headers:{'X-CSRF':csrf,'Origin':target},data:{requestID:crypto.randomUUID(),searchIDs:pages.slice(0,11)}})).status(),409);
    await page.getByRole('button',{name:'Previous records',exact:true}).click();
    await until(async()=>(await page.locator('body').innerText()).includes('6–10 shown'),'previous advances by selected page size');
    assert.equal(await page.locator('input[type="checkbox"][aria-label^="Select "]:checked').count(),5);
    await selectionControl(page, 'Deselect all');
    assert(await page.getByRole('button',{name:'Create batch (0/10)',exact:true}).isDisabled());
    await setSavedCheckbox(page, boxes.first(), true);
    await page.getByRole('button',{name:'Previous records',exact:true}).click();
    await until(async()=>(await page.locator('body').innerText()).includes('1–5 shown'),'first saved page');
    await setSavedCheckbox(page, boxes.first(), true);
    const selectedIds=[pages[5],pages[0]];
    const post=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/batches'));
    await page.getByRole('button',{name:'Create batch (2/10)',exact:true}).click();
    assert.deepEqual((await post).postDataJSON().searchIDs,selectedIds);
    await until(async()=>(await page.locator('.batch-panel').innerText().catch(()=>'' )).includes('2 selected records'),'cross-page admitted batch');
    const heldId=(await page.getByRole('heading',{name:/^Batch BAT-/}).innerText()).split(/\s+/).at(-1);
    await until(async()=>(await page.locator('.batch-panel').innerText()).includes('clarification'),'cross-page held reasons');
    // The independent workbook oracle compares a separate GET with a later export.
    // Wait for BOTH source-restricted items to settle, not just the first reason:
    // queued -> unavailable between those snapshots is valid worker progress.
    await until(async()=>{
      const response=await page.request.get(`${target}/api/libraries/${libraryId}/batches/${heldId}`);
      assert.equal(response.status(),200);const value=await response.json();
      return value.items.length===2&&value.items.every(item=>item.state==='unavailable'&&item.reason.includes('clarification'));
    },'both held items stable before separate workbook oracle snapshot');
    await verifyXlsx('Export batch XLSX',heldId);
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: capturedRunId}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    await until(async()=>await boxes.count()===3,'original saved run reopen');
    await selectionReady(page);
    await openDisclosure(page, "Export saved results and other actions");
    await until(async()=>await page.getByRole('button',{name:'Create batch (0/10)',exact:true}).isDisabled(),'reopened run retains its prior explicit deselection');
  });
  await check('delayed-xlsx-saved-run-switch-fence',async()=>{
    let release; const gate=new Promise(r=>release=r);let captured;const ready=new Promise(r=>captured=r);let downloads=0;
    const observe=()=>downloads++;page.on('download',observe);
    const handler=async route=>{if(route.request().postDataJSON()?.format!=='xlsx')return route.continue();const response=await route.fetch();assert.equal(response.status(),200);captured();await gate;await route.fulfill({response});};
    await page.route('**/exports',handler);
    await page.getByRole('button',{name:'Export saved XLSX',exact:true}).click();await ready;
    const options=await page.locator('.history-id').evaluateAll(xs=>xs.map(x=>x.textContent.replace('Search Run ID: ','')));
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: options.find(x=>x!==capturedRunId)}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    release();await page.waitForTimeout(350);assert.equal(downloads,0,'late XLSX must not save after saved-run change');
    await page.unroute('**/exports',handler);page.off('download',observe);
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: capturedRunId}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    await showWorkspace(page, "Downloads"); await page.getByLabel('Saved batches',{exact:true}).selectOption(capturedBatchId);
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'saved batch reopened after schedule');
  });
  await check('library-selection-and-export-ownership',async()=>{
    await showWorkspace(page, "Search & PDFs"); const boxes=page.locator('input[type="checkbox"][aria-label^="Select "]');await setSavedCheckbox(page, boxes.first(), true);
    await showWorkspace(page, "Libraries"); await page.getByLabel('New library name',{exact:true}).fill('SYNTHETIC second isolated library');
    await page.getByRole('button',{name:'Create',exact:true}).click();
    const choose=page.getByLabel('Choose library',{exact:true});
    await until(async()=>await choose.locator('option').count()===3,'second library not refreshed');
    const other=(await choose.locator('option').evaluateAll(xs=>xs.map(x=>x.value))).find(x=>x&&x!==libraryId);
    await choose.selectOption(other);await showWorkspace(page, "Search & PDFs"); await openDisclosure(page, "Export saved results and other actions"); assert.equal(await boxes.count(),0);assert(await page.getByRole('button',{name:'Create batch (0/10)',exact:true}).isDisabled());
    const denied=await page.evaluate(async ({other,batch,owned})=>{
      // Catalog reads can briefly fill the two-request admission budget after a
      // library switch. Retry only the explicit not-admitted GET response; an
      // authentication failure or unknown throttle is still a failed precondition.
      let session;
      for(let attempt=0;attempt<3;attempt++){
        session=await fetch('/api/session');if(session.status===200)break;
        const status=session.status,retry=session.headers.get('Retry-After'),body=await session.text();
        if(status!==429||retry!=='2'||JSON.parse(body)?.code!=='admission_not_started'||attempt===2)
          throw Error(`session precondition: status=${status} retry=${retry} body=${body}`);
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
      const {csrf}=await session.json();if(typeof csrf!=='string'||!csrf)throw Error('CSRF precondition');
      const init={method:'POST',headers:{'X-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify({format:'xlsx',batchID:batch})};
      const positive=await fetch(`/api/libraries/${owned}/exports`,init);if(positive.status!==200||positive.headers.get('Content-Type')!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')throw Error('same-session owned workbook precondition');await positive.arrayBuffer();
      const response=await fetch(`/api/libraries/${other}/exports`,init);
      return {status:response.status,attachment:response.headers.get('Content-Disposition'),body:await response.text()};
    },{other,batch:capturedBatchId,owned:libraryId});
    assert.equal(denied.status,409,JSON.stringify(denied));assert(!denied.attachment);
    await choose.selectOption(libraryId);
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: capturedRunId}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    await showWorkspace(page, "Downloads"); await page.getByLabel('Saved batches',{exact:true}).selectOption(capturedBatchId);
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'original library batch reopened');
  });
  await check("logout-relogin-and-narrow-layout", async () => {
    const prior=[searchPosts,batchPosts];
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "wide layout must not overflow");
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'populated narrow overflow');
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Login", { exact: true }).waitFor();
    assert.equal(await page.getByText(/Batch /).count(), 0, "private batch must clear on logout");
    await login(account);
    await page.getByLabel('Choose library',{exact:true}).selectOption(libraryId);
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: capturedRunId}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    await showWorkspace(page, "Downloads"); await page.getByLabel("Saved batches", { exact: true }).selectOption(capturedBatchId);
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'relogin batch not reopened');
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("Choose library", { exact: true }).waitFor();
    await page.getByLabel('Choose library',{exact:true}).selectOption(libraryId);
    await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({hasText: capturedRunId}).click(); await page.getByLabel("Search PubMed", { exact: true }).waitFor({ state: "visible" });
    await showWorkspace(page, "Downloads"); await page.getByLabel("Saved batches", { exact: true }).selectOption(capturedBatchId);
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'reload batch not reopened');
    assert.deepEqual([searchPosts,batchPosts],prior,'reopen must not submit acquisition/search');
    assert(await page.getByText(new RegExp(capturedBatchId)).count() > 0, "saved batch must reopen after reload");
    assert(input.accounts.length >= 2, "two accounts are required for tenant privacy acceptance");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Login", { exact: true }).waitFor();
    await login(input.accounts[1]);
    const libraries=await page.request.get(target+'/api/libraries',{maxRedirects:0});assert.equal((await libraries.json()).items.length,0);assert.equal((await page.request.get(target+'/api/libraries/'+libraryId,{maxRedirects:0})).status(),404);
    assert.equal(await page.getByText(new RegExp(capturedBatchId)).count(), 0, "tenant B must not see tenant A batch");
    assert.equal(await page.getByText(/SYNTHETIC ONLY|synthetic α|990000001/i).count(), 0, "tenant B must not see tenant A records");
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "narrow layout must not overflow");
  });
  assert.equal(runtimeErrors.length, 0, `browser runtime errors: ${runtimeErrors.join("; ")}`);
  console.log(JSON.stringify({ pass: true, checks, source_revision: input.source_revision, original_receipts: expectedOriginals.size, chromium:browser.version(), searchPosts,batchPosts,scope:'Synthetic transport; actual native handlers/PostgreSQL/browser' }));
} catch (error) {
  console.error(JSON.stringify({ scope: 'Synthetic test diagnostics only', checks, runtimeErrors,
    url: page.url(), body: (await page.locator('body').innerText().catch(() => 'unavailable')).slice(0, 12000) }));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
