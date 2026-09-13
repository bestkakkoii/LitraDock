// SYNTHETIC isolated HTTP schedules and metadata; no native/source qualification.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { chromium, expect } from "@playwright/test";
const root = process.cwd(), out = path.join(root, ".litradock/runtime/frontend017", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const tree = folder => Object.fromEntries(fs.readdirSync(path.join(root, folder), { recursive: true }).filter(f => fs.statSync(path.join(root, folder, f)).isFile()).sort()
  .map(f => [f.replaceAll("\\", "/"), hash(fs.readFileSync(path.join(root, folder, f)))]));
const before = { source: tree("src"), dist: tree("dist") }, result = { scope: "SYNTHETIC compiled browser and loopback HTTP only", before, cases: [], downloads: [] };
const assets = new Map(Object.keys(before.dist).map(f => [`/${f}`, fs.readFileSync(path.join(root, "dist", f))]));
const id = `RUN-${"1".repeat(32)}`, legacy = `RUN-${"2".repeat(32)}`;
const query = 'SYNTHETIC ("Neoplasms"[MeSH Terms] AND (治療 OR αβ OR "immune response")) — 長篇多語研究標題';
const article = i => ({ SearchId: `SYNTHETIC-${i}`, Title: `${query} ${i}`, Pmid: String(100000 + i), Doi: `SYNTHETIC-DOI-${i}`, OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/${100000 + i}/` });
let account = "", count = 1, state = "ready", revision = 1, attempts = 1, provider = 25001, failGet = false, controlInvalid = true, hold = null, holdRecordRead = null;
const initialFailures = ["empty", "truncated"];
const posts = [], errors = [], downloads = [], held = new Map();
const run = runID => ({ run_id: runID, input: query, total: runID === legacy ? 10000 : provider, fetched: runID === legacy ? 0 : count, state: "partial" });
const continuation = () => ({ runID: id, revision, state, windowLimit: 1000, windowCount: Math.min(provider, 1000), processedCount: count + (count < 1000 ? 1 : 0), savedCount: count, missingCount: count < 1000 ? 1 : 0, missingPMIDs: count < 1000 ? ["99999999"] : [],
  providerTotal: provider, pageSize: 100, attempts, canContinue: ["ready", "cancelled"].includes(state), canRetry: ["failed", "rate_wait"].includes(state) && attempts < 3,
  canCancel: ["queued", "running"].includes(state), reason: `SYNTHETIC ${state} reason`, snapshotAt: "2026-09-13T00:00:00Z" });
const seen = new Map();
const csv = Buffer.from('Search ID,Title\r\nSYNTHETIC-0,"治療 αβ, quoted ""title"""\r\n', "utf8");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"), route = url.pathname;
    const reply = (body, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && assets.has(route === "/" ? "/index.html" : route)) {
      const file = route === "/" ? "/index.html" : route;
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); return res.end(assets.get(file));
    }
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "POST") posts.push({ route, body });
    if (route === "/api/login") { account = body.login; return reply({ csrf: "SYNTHETIC" }); }
    if (route === "/api/logout") { account = ""; return reply({}); }
    if (!account) return reply({ error: "SYNTHETIC anonymous" }, 401);
    if (route === "/api/session") return reply({ csrf: "SYNTHETIC" });
    if (route === "/service-info") return reply({ searchEnabled: true, searchContinuationEnabled: true, searchWindowLimit: 1000, savedSetEnabled: false, planEnabled: true, pdfEnabled: false, acquisitionEnabled: false });
    if (route === "/api/libraries") return reply({ items: account === "B" ? [{ library_id: "LB", name: "SYNTHETIC B" }] : [{ library_id: "L1", name: "SYNTHETIC A" }, { library_id: "L2", name: "SYNTHETIC second" }], total: account === "B" ? 1 : 2 });
    if (/^\/api\/libraries\/[^/]+$/.test(route)) return reply({ runs: route.endsWith("L1") ? [run(id), run(legacy)] : [], batches: [], totals: { runs: route.endsWith("L1") ? 2 : 0, batches: 0 }, offset: 0, limit: 25 });
    if (route.endsWith("/plans")) return reply({ plans: [], total: 0, offset: 0, limit: 25 });
    if (route.endsWith("/search")) {
      const prior = seen.get(body.requestID); if (prior) assert.deepEqual(body, prior); else seen.set(body.requestID, body);
      const failure = initialFailures.shift();
      if (failure === "empty") return reply({});
      if (failure === "truncated") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100", "Connection": "close" }); res.flushHeaders(); return res.end('{"id":'); }
      failGet = true; return reply({ id });
    }
    if (route.endsWith("/continuation")) {
      const prior = seen.get(body.requestID); if (prior) assert.deepEqual(body, prior); else {
        seen.set(body.requestID, body); revision++;
        if (body.action === "continue") count = Math.min(count + 100, 1000);
        state = body.action === "cancel" ? "cancelled" : "ready";
      }
      if (hold) { const { key, status } = hold; hold = null; res.writeHead(status, { "Content-Type": "application/json" }); res.flushHeaders();
        held.set(key, () => res.end(JSON.stringify(status === 200 ? { runID: id, revision, state } : { error: "SYNTHETIC held error" }))); return; }
      if (controlInvalid) { controlInvalid = false; return reply({ runID: id, revision: 0, state }); }
      return reply({ runID: id, revision, state });
    }
    if (route.endsWith("/exports")) { assert.deepEqual(body, { runID: id, format: "csv" }); res.writeHead(200, { "Content-Type": "text/csv", "Content-Length": csv.length }); return res.end(csv); }
    if (route.includes("/runs/")) {
      if (failGet) return reply({ error: "SYNTHETIC detail unavailable" }, 503);
      const runID = route.split("/").at(-1), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      const total = runID === legacy ? 0 : count;
      const payload = { run: run(runID), continuation: runID === legacy ? null : continuation(), records: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => article(offset + i)), total, offset, limit };
      if (holdRecordRead && offset === holdRecordRead.offset && limit === holdRecordRead.limit) {
        const key = holdRecordRead.key; holdRecordRead = null; res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders();
        held.set(key, () => res.end(JSON.stringify(payload))); return;
      }
      return reply(payload);
    }
    reply({ error: "SYNTHETIC route absent" }, 404);
  } catch (error) { errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version(); page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(12000);
  page.on("pageerror", e => errors.push(String(e))); page.on("download", file => downloads.push(file));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { errors.push("External request blocked"); return route.abort(); } return route.continue(); });
  await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = (url, init) => fetch(url, window.__ignoreAbort ? { ...init, signal: undefined } : init); });
  const button = name => page.getByRole("button", { name, exact: true });
  const panel = () => page.getByRole("region", { name: "Search continuation" });
  const login = async who => { await page.getByLabel("Login", { exact: true }).fill(who); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue(who === "B" ? "LB" : "L1"); };
  const open = async runID => { await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: new RegExp(`${runID}$`) }) }).click(); await expect(page.locator(".query-snapshot")).toContainText(runID); };
  const refresh = async () => { await button("Refresh saved search status").click(); await expect(panel().getByRole("status").first()).toContainText(state.replaceAll("_", " ")); };
  await page.goto(origin); await login("A"); await page.getByLabel("Query", { exact: true }).fill(query);
  await page.getByLabel("Retrieved limit", { exact: true }).selectOption("5"); await expect(page.getByLabel("Retrieved limit", { exact: true })).toHaveValue("5");
  await page.getByLabel("Retrieved limit", { exact: true }).selectOption("100"); await button("Search PubMed").click();
  await expect(button("Retry same search request")).toBeVisible(); await page.getByLabel("Query", { exact: true }).fill("SYNTHETIC changed query"); await expect(button("Search PubMed")).toBeDisabled();
  await button("Retry same search request").click(); await expect(button("Retry same search request")).toBeVisible();
  await button("Retry same search request").click(); await expect(button(`Reopen confirmed search ${id}`)).toBeVisible();
  failGet = false; await button(`Reopen confirmed search ${id}`).click(); await expect(button("Select all")).toBeEnabled();
  const searches = posts.filter(p => p.route.endsWith("/search")); assert.equal(searches.length, 3); searches.forEach(post => assert.deepEqual(post.body, searches[0].body)); assert.equal(searches[0].body.limit, 100);
  await panel().getByText("Missing metadata identities (1)", { exact: true }).click(); await expect(panel().getByRole("link", { name: "PMID 99999999" })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/99999999/");
  result.cases.push("Malformed source200 and actual truncated closed HTTP body preserve exact UUID/query/limit across three explicit application attempts despite edited draft; confirmed receipt+detail503 uses GET-only recovery");
  await expect(page.locator(".selection-toolbar")).toContainText("1 selected of 1"); await button("Add checked records to basket (1)").click(); await button("Deselect all").click();
  await button("Retrieve next metadata page").focus(); await page.keyboard.press("Enter"); await expect(button("Retry same search request")).toBeVisible();
  await open(legacy); await expect(panel()).toContainText("no continuation window"); await button("Retry same search request").click();
  await expect(page.locator(".selection-toolbar")).toContainText("0 selected of 101");
  const actions = posts.filter(p => p.route.endsWith("/continuation")); assert.equal(actions.length, 2); assert.deepEqual(actions[0].body, actions[1].body);
  // A real run change resets selection; reopening a >100 set never defaults to an unseen subset.
  await expect(page.locator(".saved-basket")).toContainText("1 records in basket"); await expect(button("Select all on this page (25)")).toBeEnabled();
  await button("Select all on this page (25)").click(); await button("Next records").click(); await expect(page.locator(".selection-toolbar")).toContainText("25 selected of 101");
  await button("Deselect all").click(); await refresh(); await expect(page.locator(".selection-toolbar")).toContainText("0 selected of 101");
  assert.equal(posts.filter(p => p.route.endsWith("/search")).length, 3);
  result.cases.push("Explicit next-page malformed receipt replay; no navigation admission; >100 visible-only selection and independent frozen basket");
  for (const value of ["queued", "running", "rate_wait", "failed", "expired", "unavailable", "window_limited", "exhausted", "cancelled", "ready"]) {
    state = value; count = ["window_limited", "exhausted"].includes(value) ? 1000 : 101; provider = value === "exhausted" ? 1000 : 25001;
    await refresh();
    await expect(button("Retrieve next metadata page")).toBeEnabled({ enabled: ["ready", "cancelled"].includes(value) });
    await expect(button("Retry metadata page")).toBeEnabled({ enabled: ["rate_wait", "failed"].includes(value) });
    await expect(button("Cancel metadata page")).toBeEnabled({ enabled: ["queued", "running"].includes(value) });
  }
  state = "rate_wait"; attempts = 3; await refresh(); await expect(button("Retry metadata page")).toBeDisabled();
  attempts = 2; state = "failed"; await refresh(); await button("Retry metadata page").click(); await expect(panel().getByRole("status").first()).toContainText("ready");
  state = "running"; await refresh(); await button("Cancel metadata page").click(); await button("Confirm metadata cancellation").click(); await expect(panel().getByRole("status").first()).toContainText("cancelled");
  result.cases.push("All ten actual states, attempts3 denial, explicit retry and confirmed cancel; reads never admit pages");
  state = "ready"; count = 101; await refresh(); await button("Select all on this page (25)").click();
  await page.evaluate(() => { window.__ignoreAbort = true; });
  holdRecordRead = { key: "old-page", offset: 25, limit: 25 }; await button("Next records").click(); await expect.poll(() => held.has("old-page")).toBe(true);
  await button("Retrieve next metadata page").click(); await expect(page.locator(".selection-toolbar")).toContainText("25 selected of 201");
  held.get("old-page")(); held.delete("old-page"); await expect(page.locator(".selection-toolbar")).toContainText("25 selected of 201");
  holdRecordRead = { key: "old-enumeration", offset: 0, limit: 100 }; count = 100; await refresh(); await expect.poll(() => held.has("old-enumeration")).toBe(true);
  count = 101; await refresh(); held.get("old-enumeration")(); held.delete("old-enumeration");
  await expect(page.locator(".selection-toolbar")).toContainText("25 selected of 101"); await expect(button("Select all on this page (25)")).toBeEnabled();
  await page.evaluate(() => { window.__ignoreAbort = false; });
  result.cases.push("Actual same-run delayed page and selection-enumeration bodies cannot regress newer saved membership or widen the established checked subset");
  for (const n of [0, 1, 100, 101, 1000]) { count = n; provider = n === 100 ? 10000 : 25001; state = n === 1000 ? "window_limited" : "ready"; await refresh(); await expect(panel()).toContainText(`${n} saved`); await expect(panel()).toContainText(`${provider.toLocaleString()} provider matches`); }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    const geometry = await page.locator(".continuation, .result-card h3").evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, text: node.textContent, title: node.tagName === "H3", lineHeight: parseFloat(getComputedStyle(node).lineHeight) })));
    assert(geometry.length >= 26); assert(geometry.every(box => box.width > (width === 390 ? 240 : 450))); assert(geometry.filter(box => box.title).every(box => box.height < 210 && box.text.includes("SYNTHETIC"))); result[`geometry${width}`] = geometry;
    await page.screenshot({ path: path.join(out, `continuation-${width}.png`), fullPage: true });
    await panel().screenshot({ path: path.join(out, `continuation-panel-${width}.png`) });
  }
  const fileEvent = page.waitForEvent("download"); await button("Export CSV").click(); const file = await fileEvent, bytes = fs.readFileSync(await file.path());
  assert.deepEqual(bytes, csv); const filename = file.suggestedFilename(); fs.writeFileSync(path.join(out, filename), bytes); result.downloads.push({ filename, bytes: bytes.length, sha256: hash(bytes) });
  result.cases.push("0/1/100/101/1000 saved versus10000/25001 provider totals; populated390/1280 keyboard/readability/overflow; exact UTF8 CSV device bytes");
  count = 1; state = "ready"; await refresh();
  for (const boundary of ["run", "library", "account"]) for (const code of [200, 401, 503]) {
    state = "ready"; await refresh(); await page.evaluate(() => { window.__ignoreAbort = true; });
    const key = `${boundary}-${code}`; hold = { key, status: code }; await button("Retrieve next metadata page").click(); await expect.poll(() => held.has(key)).toBe(true);
    if (boundary === "run") await open(legacy);
    else if (boundary === "library") await page.getByLabel("Choose library", { exact: true }).selectOption("L2");
    else { await button("Sign out").click(); await login("B"); }
    held.get(key)(); held.delete(key);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(button("Sign out")).toBeVisible();
    if (boundary === "run") { await expect(page.locator(".query-snapshot")).toContainText(legacy); await page.reload(); }
    else if (boundary === "library") { await expect(page.locator(".query-snapshot")).toHaveCount(0); await page.getByLabel("Choose library", { exact: true }).selectOption("L1"); }
    else { await expect(page.locator(".query-snapshot")).toHaveCount(0); await button("Sign out").click(); await login("A"); }
    await page.evaluate(() => { window.__ignoreAbort = false; }); await open(id);
  }
  result.cases.push("Actual held POST body200/401/503 after run/library/account retirement cannot publish foreign status or expire the new session");
  assert.deepEqual(errors, []); result.posts = posts; result.after = { source: tree("src"), dist: tree("dist") }; assert.deepEqual(result.after, before); result.pass = true;
} catch (error) { result.pass = false; result.error = String(error.stack ?? error); result.posts = posts; result.runtimeErrors = errors; if (page) result.alerts = await page.getByRole("alert").allTextContents(); process.exitCode = 1; }
finally { for (const release of held.values()) release(); await browser?.close(); await new Promise(resolve => server.close(resolve)); result.serverClosed = true; result.driverSha256 = hash(fs.readFileSync(new URL(import.meta.url))); fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ pass: result.pass, cases: result.cases, error: result.error, receipt: out }, null, 2)); }
