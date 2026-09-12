import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
    const newLibrary = page.getByLabel("New library name", { exact: true });
    await newLibrary.fill(`native-browser-${Date.now()}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await until(async()=>!!(await page.getByLabel('Choose library',{exact:true}).inputValue()),'new library not selected');
    libraryId=await page.getByLabel('Choose library',{exact:true}).inputValue();
  });
  await check('loading-and-source-error',async()=>{
    await page.getByLabel('Query',{exact:true}).fill('SYNTHETIC_ERROR');
    await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
    await page.getByRole('button',{name:'Working…',exact:true}).waitFor();
    await until(async()=>(await page.locator('body').innerText()).includes('NCBI denied access'),'truthful provider denial absent');
    assert.equal(await page.getByLabel('Query',{exact:true}).inputValue(),'SYNTHETIC_ERROR','query label must remain stable with populated text');
  });
  await check("search-partial-count-and-reopen", async () => {
    await page.getByLabel("Query", { exact: true }).fill('"synthetic α" AND PMID:123');
    await page.getByRole("button", { name: "Search PubMed", exact: true }).click();
    await until(async()=>(await page.locator('body').innerText()).includes('retrieved 3 of 25000'),'truthful partial totals absent');
    await page.getByLabel("Saved searches", { exact: true }).locator("option").first().waitFor({state:'attached'});
    const saved = page.getByLabel("Saved searches", { exact: true });
    capturedRunId = await saved.inputValue();
    assert(capturedRunId, "saved run id must be captured for reopen");
  });
  await check("batch-controls-and-exact-exports", async () => {
    const records = page.locator('input[type="checkbox"][aria-label^="Select "]');
    assert.equal(await records.count(), 3, "synthetic native transport must expose exactly three records");
    for (const record of await records.all()) await record.check();
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
  await check("logout-relogin-and-narrow-layout", async () => {
    const prior=[searchPosts,batchPosts];
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "wide layout must not overflow");
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'populated narrow overflow');
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Login", { exact: true }).waitFor();
    assert.equal(await page.getByText(/Batch /).count(), 0, "private batch must clear on logout");
    await login(account);
    await page.getByLabel("Saved searches", { exact: true }).selectOption(capturedRunId);
    await page.getByLabel("Saved batches", { exact: true }).selectOption(capturedBatchId);
    await until(async()=>await page.getByRole('button',{name:'Save XML',exact:true}).count()===2,'relogin batch not reopened');
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("Choose library", { exact: true }).waitFor();
    await page.getByLabel("Saved searches", { exact: true }).selectOption(capturedRunId);
    await page.getByLabel("Saved batches", { exact: true }).selectOption(capturedBatchId);
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
