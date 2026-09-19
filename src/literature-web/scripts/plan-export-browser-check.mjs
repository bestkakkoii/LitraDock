// SYNTHETIC loopback transport and files only; not native Go/PG/provider evidence.
import { setSavedCheck, createSelectionFixture, showWorkspace, openDisclosure } from "./workspace-navigation.mjs";
import assert from "node:assert/strict";
import { installBodyGates } from "./body-gates.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preview } from "vite";
import { chromium, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../../../tests/native-browser/node_modules/fflate/esm/index.mjs";

const selectionFixture = createSelectionFixture();
const root = process.cwd(), out = path.join(root, ".litradock/runtime/frontend014", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const treeHashes = directory => Object.fromEntries(fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => fs.statSync(path.join(root, directory, file)).isFile()).sort()
  .map(file => [file.replaceAll("\\", "/"), hash(fs.readFileSync(path.join(root, directory, file)))]));
const before = { source: treeHashes("src"), dist: treeHashes("dist") };
const result = { scope: "SYNTHETIC compiled UI, isolated HTTP and exact device bytes; NOT native/archive/source qualification", before, cases: [], downloads: [] };
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser, page;
const xml = Buffer.from('<article synthetic="true">SYNTHETIC 中文 α original XML; not a real paper</article>');
const digest = hash(xml), filePath = `originals/${digest}.xml`;
const phases = { waiting: 0, queued: 0, running: 0, completed: 2, held: 1, retry: 0, paused: 0, cancelled: 0 };
const article = i => ({ SearchId: `S${i}`, Title: `SYNTHETIC 中文 "title" ${i}`, Pmid: `000${i}`, Doi: "10.123/α", OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/${i + 1}/` });
const run = id => ({ run_id: id, input: `SYNTHETIC "中文"[Title] AND α ${id}`, total: 25001, fetched: 3, state: "partial" });
function summary(id, revision = 2, active = false) {
  return { planID: id, runID: "R1", requestedFormat: "xml", revision, selectedCount: 3, state: active ? "active" : "complete",
    createdAt: "2026-09-13T00:00:00Z", updatedAt: `2026-09-13T00:00:${String(revision).padStart(2, "0")}Z`, allowedActions: [],
    counts: active ? { ...phases, running: 1, completed: 1 } : phases,
    admission: { admittedCount: 3, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 0 };
}
function document(id, revalidated = false) {
  const original = { kind: "source_original", format: "XML", mediaType: "application/xml", sha256: digest, bytes: xml.length,
    depositVersion: null, version: "SYNTHETIC", sourceUri: "https://example.invalid/synthetic.xml", rightsUri: "https://example.invalid/rights", repositoryStamp: "SYNTHETIC", acquiredAt: "2026-09-13T00:00:00Z", availability: "not_revalidated" };
  const records = Array.from({ length: 3 }, (_, i) => ({ searchId: `S${i}`, runIds: ["R1"],
    identifiers: { pmid: `000${i}`, pmcid: null, doi: "10.123/α" }, publication: { title: `SYNTHETIC "中文"\nline ${i}`, abstract: null },
    sourceLinks: { pubmed: `https://pubmed.ncbi.nlm.nih.gov/${i + 1}/`, pmc: null, doi: null, doiLinkState: "unresolved" },
    originals: i < 2 ? [original] : [] }));
  return { schema: "litradock.plan-export", schemaVersion: 1, type: "document", generatedAt: "2026-09-13T00:00:00Z", plan: summary(id),
    originalsRevalidated: revalidated,
    counts: { members: 3, includedRecords: revalidated ? 2 : null, unresolvedRecords: revalidated ? 1 : null, uniqueOriginals: revalidated ? 1 : null, originalBytes: revalidated ? xml.length : null },
    items: records.map((record, i) => ({ searchId: record.searchId, rank: i + 1, childBatchId: "B1", acquisitionState: i < 2 ? "acquired" : "unavailable", phase: i < 2 ? "completed" : "held", reason: i < 2 ? "" : "SYNTHETIC held", originalHash: i < 2 ? digest : null,
      availability: i < 2 ? revalidated ? "included" : "not_revalidated" : "not_acquired", availabilityReason: i < 2 && revalidated ? null : "SYNTHETIC unavailable or not checked",
      file: revalidated && i < 2 ? filePath : null, original: revalidated && i < 2 ? original : null })),
    research: { schema: "litradock.research-export", schemaVersion: 1, type: "document", generatedAt: "2026-09-13T00:00:00Z",
      scope: { kind: "plan", planId: id, runId: null, batchId: null, selection: "all_saved_scope" },
      counts: { exportedRecords: 3, scopeRecords: 3, providerMatches: null, retrievedRecords: null }, queryContexts: [], records } };
}
function bytes(id, format) {
  const metadata = document(id, format === "zip");
  return format === "json" ? Buffer.from(JSON.stringify(metadata)) : Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify(metadata)), "records.json": Buffer.from(JSON.stringify(metadata.research)), [filePath]: xml,
  }, { level: 0, mtime: new Date("2026-09-13T00:00:00Z") }));
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version(); page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(12000);
  const errors = [], downloads = [], posts = [], external = [], reads = [];
  page.on("pageerror", error => errors.push(String(error))); page.on("download", file => downloads.push(file));
  await page.addInitScript(installBodyGates);
  let account = "A", authenticated = false, mode = "valid", active = false, revision = 2;
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    const reply = (value, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(value) });
    if (url.pathname === "/service-info") return reply({ durableSelectionEnabled: true, selectionWriteEnabled: true, selectionRecordLimit: 1000, pdfEnabled: false, planEnabled: false, acquisitionEnabled: false });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (method === "POST") posts.push({ path: url.pathname, body: request.postDataJSON(), csrf: request.headers()["x-csrf"] });
    if (url.pathname === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
    if (url.pathname === "/api/login") { authenticated = true; account = request.postDataJSON().login; return reply({ csrf: "SYNTHETIC" }); }
    if (url.pathname === "/api/logout") { authenticated = false; return reply({}); }
    if (url.pathname === "/api/libraries") return reply({ items: (account === "B" ? ["LB"] : ["L1", "L2"]).map(id => ({ library_id: id, name: `SYNTHETIC ${id}` })), total: account === "B" ? 1 : 2 });
    if (/\/api\/libraries\/[^/]+$/.test(url.pathname)) return reply({ runs: [run("R1"), run("R2")], batches: [], totals: { runs: 2, batches: 0 }, offset: 0, limit: 100 });
    if (url.pathname.endsWith("/selection")) {
      const selectionRun = url.pathname.split("/").at(-2);
      return selectionFixture(account + url.pathname, selectionRun, [article(0), article(1), article(2)], route.request().method(), route.request().method() === "POST" ? route.request().postDataJSON() : null, reply);
    }
    if (url.pathname.includes("/runs/")) return reply({ run: run(url.pathname.split("/").at(-1)), records: [article(0), article(1), article(2)], total: 3, offset: 0, limit: 25 });
    if (url.pathname.endsWith("/plans")) return reply({ plans: [summary("P1"), summary("P2")], total: 2, offset: 0, limit: 25 });
    if (url.pathname.endsWith("/exports")) {
      assert.deepEqual(Object.keys(request.postDataJSON()), ["format"]);
      const format = request.postDataJSON().format, id = url.pathname.split("/").at(-2);
      if (["401", "409", "429", "503"].includes(mode)) return reply({ error: "SYNTHETIC failure" }, Number(mode), mode === "429" ? { "Retry-After": "2" } : {});
      if (mode === "lost") return route.abort("failed");
      if (mode === "media") return route.fulfill({ contentType: "text/html", body: "SYNTHETIC login" });
      if (mode === "malformed") return reply({ error: "SYNTHETIC error" });
      return route.fulfill({ contentType: format === "json" ? "application/json; charset=utf-8" : "application/zip", body: bytes(id, format) });
    }
    if (url.pathname.includes("/plans/")) {
      const id = url.pathname.split("/").at(-1), offset = Number(url.searchParams.get("offset")); reads.push(url.pathname); revision++;
      return reply({ plan: summary(id, revision, active), items: [{ searchID: `S${offset}`, rank: offset + 1, childBatchID: "B1", phase: offset === 0 ? "completed" : "held", acquisitionState: offset === 0 ? "acquired" : "unavailable", reason: "SYNTHETIC outcome", attempts: 1, retryEligible: false, downloadAvailable: false, article: article(offset) }], total: 3, offset, limit: 1, nextPollAfterMs: 2000, policy: "SYNTHETIC" });
    }
    if (url.pathname.includes("/batches/B1")) return reply({ batch: { batch_id: "B1", state: "complete", created_at: "2026-09-13" }, requestedFormat: "xml", items: [], total: 0, counts: {} });
    return reply({ error: "Synthetic route absent" }, 404);
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const names = { json: "Export plan metadata JSON", zip: "Download available originals ZIP" };
  const login = async who => { await page.getByLabel("Login", { exact: true }).fill(who); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue(who === "B" ? "LB" : "L1"); };
  const openRun = async id => { await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: new RegExp(`${id}$`) }) }).click(); await expect(button("Select all saved")).toBeEnabled(); };
  const open = async id => { await showWorkspace(page, "Research plans"); await page.getByLabel("Saved plans", { exact: true }).selectOption(id); await expect(page.getByRole("heading", { name: `Plan ${id}`, exact: true })).toBeVisible(); await expect(button(names.json)).toBeEnabled(); };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hold = async (id, format, failure = "valid") => { mode = failure; await page.evaluate(id => { window.__nextHold = id; }, id); await button(names[format]).click(); await page.waitForFunction(id => !!window.__holds[id], id); mode = "valid"; await expect(page.getByRole("status").filter({ hasText: /Preparing (originals ZIP|metadata JSON)|bytes received/ })).toBeVisible(); };
  const release = async id => { await page.evaluate(id => window.__holds[id](), id); await settle(); };
  const verify = async (file, id, format) => {
    const data = fs.readFileSync(await file.path()); assert.deepEqual(data, bytes(id, format));
    assert.equal(file.suggestedFilename(), format === "json" ? "litradock-plan.json" : "litradock-plan-originals.zip");
    if (format === "json") {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      assert.equal(value.items.length, 3); assert.equal(value.originalsRevalidated, false); assert.equal(value.counts.includedRecords, null);
      assert.equal(value.research.records[0].publication.title, 'SYNTHETIC "中文"\nline 0'); assert.equal(value.research.records[0].identifiers.pmid, "0000");
    } else {
      const members = unzipSync(data); assert.deepEqual(Object.keys(members).sort(), [filePath, "manifest.json", "records.json"].sort());
      const manifest = JSON.parse(Buffer.from(members["manifest.json"])); assert.deepEqual(Buffer.from(members[filePath]), xml);
      assert.deepEqual(JSON.parse(Buffer.from(members["records.json"])), manifest.research);
      assert.equal(manifest.counts.includedRecords, 2); assert.equal(manifest.counts.unresolvedRecords, 1); assert.equal(manifest.counts.uniqueOriginals, 1);
      assert.equal(manifest.items[2].file, null); assert.equal(manifest.items[2].availability, "not_acquired"); assert.equal(hash(members[filePath]), digest);
    }
    const filename = `${result.downloads.length}-${file.suggestedFilename()}`; fs.writeFileSync(path.join(out, filename), data);
    result.downloads.push({ filename, sha256: hash(data), bytes: data.length });
  };
  const download = async (id, format) => { const event = page.waitForEvent("download"); await button(names[format]).click(); await verify(await event, id, format); await expect(button(names[format])).toBeEnabled(); assert.deepEqual(posts.at(-1).body, { format }); assert.equal(posts.at(-1).csrf, "SYNTHETIC"); };
  await page.goto(origin); await login("A"); await openRun("R1"); await button("Deselect all").click(); await open("P1");
  assert.equal(posts.filter(post => post.path.endsWith("/exports")).length, 0);
  await button("Next plan items").click(); await expect(page.locator(".plan-item")).toHaveCount(1);
  await download("P1", "json"); await download("P1", "zip");
  result.cases.push("Disabled new acquisition preserves explicit wholeplan JSON/ZIP exports; one visible item and zero checks still export all3; exact POST body/CSRF/filenames/UTF8 and ZIP member bytes/counts");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    for (const name of Object.values(names)) { const box = await button(name).boundingBox(); assert(box.width > 120 && box.height >= 36); }
    await openDisclosure(page.locator(".plan-exports"), "Export scope, limits and alternatives");
    await expect(page.locator(".plan-exports")).toContainText("32 MiB"); await expect(page.locator(".plan-exports")).toContainText("37 MiB");
    await page.locator(".plan-workspace").screenshot({ path: path.join(out, `plan-exports-${width}.png`) });
  }
  result.cases.push("Populated desktop1280/narrow390 readable controls/limits/manifest distinction; no document overflow");
  for (const failure of ["409", "429", "503", "lost", "media", "malformed"]) {
    const count = downloads.length, postCount = posts.length; mode = failure; await button(names.json).click();
    await expect(page.locator(".plan-exports [role=alert]")).toBeVisible(); await expect(button(names.json)).toBeEnabled(); await settle();
    assert.equal(downloads.length, count); assert.equal(posts.length, postCount + 1);
    if (failure === "429") await expect(page.locator(".plan-exports [role=alert]")).toContainText("2 seconds");
    if (failure === "409") await expect(page.locator(".plan-exports [role=alert]")).toContainText("child batch"); mode = "valid";
  }
  result.cases.push("409/429 RetryAfter2/503/lost/media/error: no file, no auto retry, explicit useful alternatives and recoverable controls");
  active = true; await button("Refresh plan").click(); await expect(button("Refresh plan")).toBeEnabled();
  await hold("polling", "json"); const readCount = reads.length;
  await expect.poll(() => reads.length).toBeGreaterThan(readCount);
  await expect(button(names.json)).toBeDisabled(); await button("Next plan items").click();
  const pollDownload = page.waitForEvent("download"); await release("polling"); await verify(await pollDownload, "P1", "json"); active = false;
  result.cases.push("Active automatic GET progress and sameplan pagination do not cancel a held export or change immutable full membership");
  for (const status of ["valid", "401", "503"]) {
    await open("P1"); const count = downloads.length; await hold(`old-${status}`, "zip", status); await open("P2");
    await hold(`new-${status}`, "json"); await release(`old-${status}`);
    assert.equal(downloads.length, count); await expect(button(names.json)).toBeDisabled(); await expect(page.locator(".plan-exports [role=alert]")).toHaveCount(0);
    const event = page.waitForEvent("download"); await release(`new-${status}`); await verify(await event, "P2", "json"); await expect(button(names.json)).toBeEnabled();
  }
  result.cases.push("Held oldplan200/401/503 never download/expire/error/clear newerbusy; newer exact-byte positive controls pass");
  for (const change of ["run", "library", "account"]) for (const status of ["valid", "401", "503"]) {
    await open("P1"); const count = downloads.length; await hold(`${change}-${status}`, "json", status);
    if (change === "run") { await openRun("R2"); }
    if (change === "library") { const library = await page.getByLabel("Choose library", { exact: true }).inputValue(); await page.getByLabel("Choose library", { exact: true }).selectOption(library === "L1" ? "L2" : "L1"); }
    if (change === "account") { await button("Sign out").click(); await login("B"); await openRun("R1"); }
    await release(`${change}-${status}`); await open("P2"); assert.equal(downloads.length, count); await download("P2", "json");
    if (change === "account") { await button("Sign out").click(); await login("A"); await openRun("R1"); }
    if (change === "run") await openRun("R1");
  }
  result.cases.push("Actual run/library/account changes fence held200/401/503 bodies with newer exports usable; no private old device output");
  await open("P1"); mode = "401"; await button(names.json).click(); await expect(page.getByLabel("Login", { exact: true })).toBeVisible();
  assert.equal(await page.locator(".plan-item,.plan-exports").count(), 0); mode = "valid"; await login("B"); await open("P1"); await download("P1", "json");
  result.cases.push("Current401 clears rendered privateplan and enables relogin plus current download");
  const selectionWrites = posts.filter(post => post.path.endsWith("/selection"));
  assert.equal(selectionWrites.length, 1, "Only the explicit initial Deselect all may write selection");
  assert.equal(selectionWrites[0].path, "/api/libraries/L1/runs/R1/selection");
  assert.equal(selectionWrites[0].body.action, "none");
  assert.deepEqual(Object.keys(selectionWrites[0].body).sort(), ["action", "requestID", "revision"]);
  assert.equal(posts.filter(post => !post.path.endsWith("/exports") && !post.path.endsWith("/selection") && !["/api/login", "/api/logout"].includes(post.path)).length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); result.after = { source: treeHashes("src"), dist: treeHashes("dist") }; assert.deepEqual(result.after, before); result.pass = true;
} catch (error) {
  result.pass = false; result.error = String(error); process.exitCode = 1;
  if (page) { result.alerts = await page.locator(".error").allTextContents(); await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }); }
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); result.serverClosed = true;
  result.driverSha256 = hash(fs.readFileSync(new URL(import.meta.url))); fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, error: result.error, cases: result.cases, downloads: result.downloads.length, receipt: out }, null, 2));
}
