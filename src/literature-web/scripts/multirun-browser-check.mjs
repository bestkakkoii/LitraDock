// SYNTHETIC loopback HTTP fixtures and files. No native Go/PG/provider evidence.
import { setSavedCheck, createSelectionFixture, showWorkspace } from "./workspace-navigation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { chromium, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../../../tests/native-browser/node_modules/fflate/esm/index.mjs";

const selectionFixture = createSelectionFixture();
const root = process.cwd();
const out = path.join(root, ".litradock/runtime/frontend016", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const tree = folder => Object.fromEntries(fs.readdirSync(path.join(root, folder), { recursive: true })
  .filter(file => fs.statSync(path.join(root, folder, file)).isFile()).sort()
  .map(file => [file.replaceAll("\\", "/"), hash(fs.readFileSync(path.join(root, folder, file)))]));
const before = { source: tree("src"), dist: tree("dist") };
// Serve an immutable in-memory compiled snapshot, not a moving Vite source tree.
const assets = new Map(Object.keys(before.dist).map(file => [`/${file}`, fs.readFileSync(path.join(root, "dist", file))]));
const result = { scope: "SYNTHETIC compiled browser + actual loopback paced HTTP + device bytes only", before, cases: [], downloads: [] };
const title = i => `SYNTHETIC ${i}: ("Neoplasms"[MeSH Terms] AND (治療 OR αβ OR "immune response")) — 長篇多語研究標題 and explicit Boolean context`;
const article = i => ({ SearchId: `S${i}`, Title: title(i), Pmid: `000${i}`, Pmcid: null, Doi: `10.123/α${i}`, OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/${i + 1}/` });
const runs = { R1: [0, 1], R2: [1, 2], R3: [3], R4: [4, 5, 6, 7, 8, 9] };
const run = id => ({ run_id: id, input: `${title(id)} SYNTHETIC query`, total: 25001, fetched: runs[id].length, state: "partial" });
const originals = [0, 1].map(i => Buffer.from(`%PDF-1.4\n% SYNTHETIC test transport only ${i} 中文\n%%EOF\n`));
let account = "A", authenticated = false, admission = true, serial = 0, nextExport = null, active = false, failedDetail = false, invalidControl = true;
const receiptFailures = ["invalidJSON", "closedBody", {}, { planID: "PLN-00000000000000000000000000000001" },
  { planID: "PLN-00000000000000000000000000000001", revision: 0, state: "active", selectedCount: 3, affectedCount: 0 },
  { planID: "PLN-00000000000000000000000000000001", revision: 1, state: "active", selectedCount: 2, affectedCount: 0 },
  { planID: "FOREIGN-MALFORMED", revision: 1, state: "active", selectedCount: 3, affectedCount: 0 }];
const admissionCalls = receiptFailures.length + 1;
const plans = new Map(), posts = [], holds = new Map(), reads = [];
function plan(id) { return plans.get(id); }
function summary(id) {
  const saved = plan(id), completed = Math.min(saved.members.length, 2);
  return { planID: id, runID: saved.scopeKind ? "" : saved.runID, ...(saved.scopeKind ? { scopeKind: "saved_set", sourceRunIDs: [...new Set(saved.members.flatMap(item => item.runIDs))].sort() } : {}),
    requestedFormat: saved.format, selectedCount: saved.members.length, revision: 2, state: active ? "active" : "partial",
    createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:01Z", allowedActions: ["pause"],
    counts: { waiting: 0, queued: 0, running: 0, completed, held: saved.members.length - completed, retry: 0, paused: 0, cancelled: 0 },
    admission: { admittedCount: saved.members.length, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 0 };
}
function document(id, revalidated = false) {
  const saved = plan(id), info = summary(id);
  const records = saved.members.map((member, i) => ({ searchId: member.searchID, runIds: member.runIDs,
    identifiers: { pmid: `000${i}`, pmcid: null, doi: `10.123/α${i}` }, publication: { title: title(i), abstract: null },
    originals: i < 2 ? [{ availability: "not_revalidated", sha256: hash(originals[i]), bytes: originals[i].length, format: "PDF" }] : [] }));
  return { schema: "litradock.plan-export", schemaVersion: 1, type: "document", generatedAt: "2026-09-13T00:00:00Z", plan: info,
    originalsRevalidated: revalidated,
    counts: { members: records.length, includedRecords: revalidated ? Math.min(2, records.length) : null, unresolvedRecords: revalidated ? Math.max(0, records.length - 2) : null, uniqueOriginals: revalidated ? Math.min(2, records.length) : null, originalBytes: revalidated ? originals.slice(0, records.length).reduce((sum, data) => sum + data.length, 0) : null },
    items: records.map((record, i) => ({ searchId: record.searchId, rank: i + 1, childBatchId: "B1", acquisitionState: i < 2 ? "acquired" : "unavailable", phase: i < 2 ? "completed" : "held", reason: i < 2 ? "" : "SYNTHETIC source policy held", originalHash: i < 2 ? hash(originals[i]) : null,
      availability: i < 2 ? revalidated ? "included" : "not_revalidated" : "not_acquired", availabilityReason: null,
      file: revalidated && i < 2 ? `originals/${hash(originals[i])}.pdf` : null, original: revalidated && i < 2 ? record.originals[0] : null })),
    research: { schema: "litradock.research-export", schemaVersion: 1, type: "document", generatedAt: "2026-09-13T00:00:00Z",
      scope: { kind: "plan", planId: id, runId: null, batchId: null, selection: "all_saved_scope" },
      counts: { exportedRecords: records.length, scopeRecords: records.length, providerMatches: null, retrievedRecords: null },
      queryContexts: [...new Set(saved.members.flatMap(item => item.runIDs))].map(runId => ({ runId, query: run(runId).input })), records } };
}
function bytes(id, format) {
  if (format === "json") return Buffer.from(JSON.stringify(document(id)));
  const metadata = document(id, true), members = { "manifest.json": Buffer.from(JSON.stringify(metadata)), "records.json": Buffer.from(JSON.stringify(metadata.research)) };
  metadata.items.forEach((item, i) => { if (item.file) members[item.file] = originals[i]; });
  return Buffer.from(zipSync(members, { level: 0, mtime: new Date("2026-09-13T00:00:00Z") }));
}
const serverErrors = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"), route = url.pathname;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const reply = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "POST") posts.push({ path: route, body, csrf: req.headers["x-csrf"] });
    if (route === "/service-info") return reply({ durableSelectionEnabled: true, selectionWriteEnabled: true, selectionRecordLimit: 1000, planEnabled: true, pdfEnabled: true, savedSetEnabled: admission, acquisitionEnabled: true });
    if (!route.startsWith("/api/")) {
      const data = assets.get(route === "/" ? "/index.html" : route);
      if (!data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": route.endsWith(".js") ? "text/javascript" : route.endsWith(".css") ? "text/css" : "text/html" }); return res.end(data);
    }
    if (route === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
    if (route === "/api/login") { authenticated = true; account = body.login; return reply({ csrf: "SYNTHETIC" }); }
    if (route === "/api/logout") { authenticated = false; return reply({}); }
    if (route === "/api/libraries") return reply({ items: (account === "A" ? ["L1", "L2"] : ["LB"]).map(library_id => ({ library_id, name: `SYNTHETIC ${library_id}` })), total: account === "A" ? 2 : 1 });
    if (/\/libraries\/[^/]+$/.test(route)) return reply({ runs: Object.keys(runs).map(run), batches: [], totals: { runs: 4, batches: 0 }, offset: 0, limit: 100 });
    if (route.endsWith("/selection")) {
      const selectionRun = route.split("/").at(-2);
      return selectionFixture(account + route, selectionRun, runs[selectionRun].map(article), req.method, req.method === "POST" ? body : null, reply);
    }
    if (route.includes("/runs/")) { const id = route.split("/").at(-1), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return reply({ run: run(id), records: runs[id].slice(offset, offset + limit).map(article), total: runs[id].length, offset, limit }); }
    if (route.endsWith("/plans") && req.method === "POST") {
      if (!admission) return reply({ error: "SYNTHETIC admission disabled" }, 409);
      assert.equal(body.scopeKind, "saved_set"); assert.equal(body.format, "pdf"); assert.equal(req.headers["x-csrf"], "SYNTHETIC");
      let id = [...plans].find(([, value]) => value.requestID === body.requestID)?.[0];
      if (!id) { id = `PLN-${String(++serial).padStart(32, "0")}`; plans.set(id, { ...body, library: route.split("/")[3], account }); }
      // A broken receipt after commit, not socket reset (Chromium may itself
      // retry a reset connection before exposing a response to the application).
      if (receiptFailures.length) {
        const failure = receiptFailures.shift();
        if (failure === "invalidJSON") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"planID":'); }
        if (failure === "closedBody") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100", "Connection": "close" }); res.flushHeaders(); return res.end('{"planID":'); }
        return reply(failure);
      }
      failedDetail = true;
      return reply({ planID: id, revision: 1, state: "active", selectedCount: body.members.length, affectedCount: 0 });
    }
    if (route.endsWith("/plans")) { const visible = [...plans].filter(([, value]) => value.account === account && value.library === route.split("/")[3]).map(([id]) => summary(id)); return reply({ plans: visible, total: visible.length, offset: 0, limit: 25 }); }
    if (route.endsWith("/control")) {
      const id = route.split("/").at(-2);
      if (invalidControl) { invalidControl = false; return reply({ planID: "PLN-ffffffffffffffffffffffffffffffff", revision: 2, state: "paused", affectedCount: 0 }); }
      return reply({ planID: id, revision: 2, state: "paused", affectedCount: 0 });
    }
    if (route.endsWith("/exports")) {
      const id = route.split("/").at(-2), mode = nextExport ?? {}; nextExport = null;
      assert.deepEqual(Object.keys(body), ["format"]);
      let data = mode.status && mode.status !== 200 ? Buffer.from('{"error":"SYNTHETIC delayed failure"}') : bytes(id, body.format);
      const headers = { "Content-Type": mode.status && mode.status !== 200 ? "application/json" : body.format === "json" ? "application/json; charset=utf-8" : "application/zip" };
      if (mode.encoded) { data = gzipSync(data); headers["Content-Encoding"] = "gzip"; }
      if (!mode.unknown) headers["Content-Length"] = String(data.length);
      res.writeHead(mode.status ?? 200, headers);
      if (mode.gate) {
        const first = mode.status && mode.status !== 200 ? 1 : Math.min(128, Math.floor(data.length / 2));
        res.write(data.subarray(0, first));
        holds.set(mode.gate, () => { res.end(data.subarray(first)); holds.delete(mode.gate); });
      } else res.end(data);
      return;
    }
    // New read-only snapshot catalog is not a plan-detail request. This
    // independent older workload has no prepared snapshots or bundle mutations.
    if (route.endsWith("/bundles") && req.method === "GET") return reply({ items: [], total: 0 });
    if (route.includes("/plans/")) {
      if (failedDetail) return reply({ error: "SYNTHETIC known receipt, detail unavailable" }, 503);
      const id = route.split("/").at(-1); reads.push(id);
      return reply({ plan: summary(id), total: plan(id).members.length, offset: 0, limit: 25, nextPollAfterMs: 2000, policy: "SYNTHETIC",
        items: plan(id).members.map((member, i) => ({ searchID: member.searchID, runIDs: member.runIDs, rank: i + 1, childBatchID: "B1", phase: i < 2 ? "completed" : "held", acquisitionState: i < 2 ? "acquired" : "unavailable", reason: i < 2 ? "SYNTHETIC acquired" : "SYNTHETIC source policy held", attempts: 1, retryEligible: false, downloadAvailable: false, article: article(i) })) });
    }
    if (route.includes("/batches/")) return reply({ batch: { batch_id: "B1", state: "partial", created_at: "2026-09-13" }, requestedFormat: "pdf", items: [], total: 0, counts: {} });
    return reply({ error: "SYNTHETIC route absent" }, 404);
  } catch (error) { serverErrors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version(); page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(12000);
  const errors = [], external = [], downloads = [];
  page.on("pageerror", error => errors.push(String(error))); page.on("download", file => downloads.push(file));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  // Error-body schedule deliberately ignores fetch abort; production code must
  // still reject the obsolete error after its actual delayed HTTP body arrives.
  await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = (url, init) => fetch(url, window.__ignoreAbort ? { ...init, signal: undefined } : init); });
  const button = name => page.getByRole("button", { name, exact: true });
  const login = async who => { await page.getByLabel("Login", { exact: true }).fill(who); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue(who === "B" ? "LB" : "L1"); };
  const openRun = async id => { await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: new RegExp(`${id}$`) }) }).click(); await expect(button("Select all saved")).toBeEnabled(); await expect(page.locator(".selection-toolbar")).toContainText(`of ${runs[id].length}`); };
  const open = async id => { await showWorkspace(page, "Research plans"); await page.getByLabel("Saved plans", { exact: true }).selectOption(id); await expect(page.getByRole("heading", { name: `Plan ${id}`, exact: true })).toBeVisible(); };
  const add = async count => { await showWorkspace(page, "Research plans"); await button(`Add checked records to basket (${count})`).click(); };
  const removeBasket = async searchID => {
    // Full saved identity remains in native details, even with concise labels.
    const row = page.locator(".basket-row").filter({ has: page.locator("dd").filter({ hasText: new RegExp(`^${searchID}$`) }) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Remove record / }).click();
  };
  const names = { json: "Export plan metadata JSON", zip: "Download available PDFs ZIP" };
  const exportButton = format => button(names[format]);
  const verify = async (file, id, format) => {
    const data = fs.readFileSync(await file.path()); assert.deepEqual(data, bytes(id, format));
    assert.equal(file.suggestedFilename(), format === "json" ? "litradock-plan.json" : "litradock-plan-originals.zip");
    if (format === "zip") { const contents = unzipSync(data); const manifest = JSON.parse(Buffer.from(contents["manifest.json"])); assert.equal(manifest.counts.includedRecords, 2); assert.equal(manifest.counts.unresolvedRecords, 1);
      manifest.items.forEach((item, i) => { if (item.file) assert.deepEqual(Buffer.from(contents[item.file]), originals[i]); else assert.equal(i, 2); }); }
    else { const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); assert.equal(metadata.plan.runID, ""); assert.equal(metadata.research.records[1].runIds.length, 2); }
    const filename = `${result.downloads.length}-${file.suggestedFilename()}`; fs.writeFileSync(path.join(out, filename), data); result.downloads.push({ filename, bytes: data.length, sha256: hash(data) });
  };
  const held = async (gate, format, extra = {}) => {
    nextExport = { gate, ...extra }; await exportButton(format).click(); await expect.poll(() => holds.has(gate)).toBe(true);
    if (!extra.status || extra.status === 200) {
      await expect(page.locator(".plan-exports [role=status]")).toContainText(extra.encoded ? "bytes received" : /^[1-9][0-9,]* bytes received/);
      result.progressSamples ??= []; result.progressSamples.push({ gate, ...extra, text: await page.locator(".plan-exports [role=status]").innerText() });
    }
  };
  const release = async gate => { const finish = holds.get(gate); assert(finish); finish(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
  await page.goto(origin); await login("A"); await openRun("R1"); await add(2); await add(2); await openRun("R2"); await add(2);
  await expect(page.locator(".saved-basket")).toContainText("3 records in basket · 2 saved searches");
  await page.locator(".saved-basket > details > summary").click(); await expect(page.locator(".saved-basket")).toContainText("4 associations");
  await removeBasket("S2"); await expect(page.locator(".saved-basket")).toContainText("2 records in basket"); await add(2);
  await button("Clear basket").click(); await openRun("R4"); await page.getByLabel("Page size", { exact: true }).selectOption("5");
  await expect(button("Select all saved")).toBeEnabled(); await add(6); await showWorkspace(page, "Search & PDFs"); await button("Next records").click(); await expect(button("Previous records")).toBeEnabled(); await add(6);
  await expect(page.locator(".saved-basket")).toContainText("6 records in basket · 1 saved searches");
  await button("Clear basket").click(); await openRun("R1"); await showWorkspace(page, "Research plans"); await button("Add checked records to basket (2)").focus(); await page.keyboard.press("Enter"); await openRun("R2"); await add(2);
  await expect(page.locator(".saved-basket")).toContainText("3 records in basket · 2 saved searches");
  assert.equal(posts.filter(post => post.path.endsWith("/plans")).length, 0);
  await button("Download basket PDFs (3)").click(); await expect(button("Retry same submission")).toBeVisible();
  await openRun("R3"); await add(1); // Changed draft must not replace the unconfirmed three-member body.
  while (receiptFailures.length) { await button("Retry same submission").click(); await expect(button("Retry same submission")).toBeVisible(); await expect(button("Download basket PDFs (4)")).toBeDisabled(); }
  await button("Retry same submission").click(); await expect(button("Reopen confirmed plan")).toBeVisible();
  await expect(button("Retry same submission")).toHaveCount(0); await openRun("R1"); await showWorkspace(page, "Research plans"); await expect(button("Download basket PDFs (4)")).toBeDisabled();
  const creates = posts.filter(post => post.path.endsWith("/plans")); assert.equal(creates.length, admissionCalls); creates.forEach(post => assert.deepEqual(post.body, creates[0].body));
  failedDetail = false; await button("Reopen confirmed plan").click(); await expect(page.getByRole("heading", { name: "Plan PLN-00000000000000000000000000000001", exact: true })).toBeVisible();
  assert.equal(posts.filter(post => post.path.endsWith("/plans")).length, admissionCalls);
  await removeBasket("S3");
  await button("Pause plan").click(); await expect(button("Retry same submission")).toBeVisible(); await button("Retry same submission").click(); await expect(button("Retry same submission")).toHaveCount(0);
  const controls = posts.filter(post => post.path.endsWith("/control")); assert.equal(controls.length, 2); assert.deepEqual(controls[0].body, controls[1].body);
  assert.deepEqual(creates[0].body.members, [{ searchID: "S0", runIDs: ["R1"] }, { searchID: "S1", runIDs: ["R1", "R2"] }, { searchID: "S2", runIDs: ["R2"] }]);
  result.cases.push("035-F1 invalidJSON, closed/truncated HTTP body, validJSON empty/missing/revision0/wrongcount/malformedID receipts preserve exact PDF UUID/body across run/draft change; validated receipt plus detail503 retains known ID and GET-only recovery; wrong-target control preserves exact replay");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    const geometry = await page.locator(".saved-basket h4, .plan-workspace > .plan-item h4").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { width: box.width, height: box.height, text: node.textContent, lineHeight: parseFloat(style.lineHeight) }; }));
    assert(geometry.length >= 6); for (const box of geometry) { assert(box.width > (width === 390 ? 240 : 450)); assert(box.height < 210); assert(box.text.includes("SYNTHETIC")); }
    result[`geometry${width}`] = geometry;
    await page.locator(".plan-workspace").screenshot({ path: path.join(out, `saved-set-${width}.png`) });
  }
  result.cases.push("Populated1280/390 long multilingual Boolean titles, provenance and controls have readable width/height and no document overflow");
  await held("run-independent", "zip"); await expect(page.locator(".plan-exports [role=status]")).toContainText("%");
  const download = page.waitForEvent("download"); await openRun("R1"); await showWorkspace(page, "Research plans"); await expect(exportButton("zip")).toBeDisabled(); await release("run-independent"); await verify(await download, "PLN-00000000000000000000000000000001", "zip");
  await expect(exportButton("zip")).toBeEnabled();
  for (const extra of [{ unknown: true }, { encoded: true }]) {
    await held("bytes-only", "json", extra); await expect(page.locator(".plan-exports [role=status]")).not.toContainText("%");
    const event = page.waitForEvent("download"); await release("bytes-only"); await verify(await event, "PLN-00000000000000000000000000000001", "json"); await expect(exportButton("json")).toBeEnabled();
  }
  active = true; await button("Refresh plan").click(); await held("poll", "json"); const readCount = reads.length;
  await expect.poll(() => reads.length).toBeGreaterThan(readCount); await expect(exportButton("json")).toBeDisabled();
  const pollDownload = page.waitForEvent("download"); await release("poll"); await verify(await pollDownload, "PLN-00000000000000000000000000000001", "json"); active = false;
  result.cases.push("Real paced HTTP byte progress; comparable length percentage versus encoded/unknown bytes-only; exact files survive run change and active plan refresh");
  await page.reload(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue("L1"); await open("PLN-00000000000000000000000000000001");
  await expect(page.locator(".saved-basket")).toContainText("0 records in basket"); assert.equal(posts.filter(post => post.path.endsWith("/plans")).length, admissionCalls);
  admission = false; await page.reload(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue("L1"); await open("PLN-00000000000000000000000000000001");
  await expect(page.locator(".saved-basket")).toContainText("New multi-search plans are unavailable");
  const disabledExport = page.waitForEvent("download"); await exportButton("json").click(); await verify(await disabledExport, "PLN-00000000000000000000000000000001", "json");
  result.cases.push("Reload/reopen is GET-only; admission-disabled saved sets and exports remain visible independently of current run");
  plans.set("PLN-00000000000000000000000000000002", { ...plans.get("PLN-00000000000000000000000000000001"), requestID: "SYNTHETIC-PLN-00000000000000000000000000000002" }); await button("Refresh saved plans").click();
  await expect(page.getByLabel("Saved plans", { exact: true })).toContainText("PLN-00000000000000000000000000000002");
  for (const status of [200, 401, 503]) {
    await open("PLN-00000000000000000000000000000001"); const count = downloads.length; await page.evaluate(() => { window.__ignoreAbort = true; }); await held(`old-${status}`, "json", { status });
    await open("PLN-00000000000000000000000000000002"); await held(`new-${status}`, "zip"); await release(`old-${status}`);
    await expect(exportButton("zip")).toBeDisabled(); assert.equal(downloads.length, count); await expect(page.locator(".plan-exports [role=alert]")).toHaveCount(0);
    const event = page.waitForEvent("download"); await release(`new-${status}`); await verify(await event, "PLN-00000000000000000000000000000002", "zip"); await expect(exportButton("zip")).toBeEnabled();
    await page.evaluate(() => { window.__ignoreAbort = false; });
  }
  result.cases.push("Delayed old200/401/503 after plan change preserve newer busy/error/session and only save newer complete bytes; synthetic error bodies ignore transport abort deliberately");
  const beforeCancel = downloads.length;
  await held("cancelled", "zip"); await button("Cancel transfer").click(); await expect(exportButton("zip")).toBeEnabled();
  await held("after-cancel", "json"); await release("cancelled"); assert.equal(downloads.length, beforeCancel); await expect(exportButton("json")).toBeDisabled();
  const resumedDownload = page.waitForEvent("download"); await release("after-cancel"); await verify(await resumedDownload, "PLN-00000000000000000000000000000002", "json"); await expect(exportButton("json")).toBeEnabled();
  result.cases.push("Explicit transfer cancel saves no prefix; later same-plan transfer owns busy state and exact completed bytes");
  for (const scope of ["library", "account"]) for (const status of [200, 401, 503]) {
    await open("PLN-00000000000000000000000000000001"); await openRun("R1"); await add(2); const count = downloads.length;
    await page.evaluate(() => { window.__ignoreAbort = true; }); await held(scope, "zip", { status });
    if (scope === "library") await page.getByLabel("Choose library", { exact: true }).selectOption("L2");
    else { await button("Sign out").click(); await login("B"); }
    await release(scope); await page.evaluate(() => { window.__ignoreAbort = false; }); assert.equal(downloads.length, count); await showWorkspace(page, "Research plans"); await expect(page.locator(".saved-basket")).toContainText("0 records in basket");
    await expect(page.getByRole("heading", { name: "Plan PLN-00000000000000000000000000000001", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Saved plans", { exact: true })).not.toContainText("PLN-00000000000000000000000000000001");
    if (scope === "library") await page.getByLabel("Choose library", { exact: true }).selectOption("L1");
    else { await button("Sign out").click(); await login("A"); }
  }
  await open("PLN-00000000000000000000000000000001"); nextExport = { status: 401 }; await exportButton("json").click(); await expect(page.getByLabel("Login", { exact: true })).toBeVisible();
  await login("A"); await open("PLN-00000000000000000000000000000001"); const finalDownload = page.waitForEvent("download"); await exportButton("json").click(); await verify(await finalDownload, "PLN-00000000000000000000000000000001", "json");
  result.cases.push("Library/account retirement clears basket/private set and blocks held downloads; current401 clears private UI and permits relogin/reopen/current export");
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(serverErrors, []);
  result.posts = posts; result.after = { source: tree("src"), dist: tree("dist") }; assert.deepEqual(result.after, before); result.pass = true;
} catch (error) {
  result.pass = false; result.error = String(error); result.serverErrors = serverErrors; process.exitCode = 1;
  result.posts = posts;
  if (page) { result.alerts = await page.locator("[role=alert]").allTextContents(); await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }); }
} finally {
  for (const finish of holds.values()) finish(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  result.serverClosed = true; result.driverSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, error: result.error, cases: result.cases, downloads: result.downloads.length, receipt: out }, null, 2));
}
