// Isolated SYNTHETIC transport. Tests the compiled frontend, not native Go/source provenance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preview } from "vite";
import { chromium, expect } from "@playwright/test";

const root = process.cwd();
const out = path.join(root, ".litradock/runtime/frontend013", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const treeHashes = directory => Object.fromEntries(fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter(file => fs.statSync(path.join(root, directory, file)).isFile()).sort()
  .map(file => [file.replaceAll("\\", "/"), hash(fs.readFileSync(path.join(root, directory, file)))]));
const before = { source: treeHashes("src"), dist: treeHashes("dist") };
const result = { scope: "SYNTHETIC HTTP transport, compiled frontend and real Chromium device-file bytes; NOT native/provider evidence", before, cases: [], downloads: [] };
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser, page;
const article = i => ({ SearchId: `S${i}`, Title: `SYNTHETIC 中文 α "quoted" record ${i}`, Pmid: `000${i}`, Doi: "10.123/α", OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/${i + 1}/` });
const run = id => ({ run_id: id, input: `SYNTHETIC "中文"[Title] AND α ${id}`, total: 25001, fetched: 7, state: "partial" });
function payload(scope, format) {
  const records = Array.from({ length: scope.runID ? 7 : 3 }, (_, i) => ({
    searchId: `S${i}`, runIds: [scope.runID ?? "R1"],
    identifiers: { pmid: `000${i}`, pmcid: null, doi: "10.123/α" },
    publication: { title: `SYNTHETIC 中文 α "quotes"\nline ${i}`, authors: null, abstract: null },
    sourceLinks: { pubmed: `https://pubmed.ncbi.nlm.nih.gov/${i + 1}/`, pmc: null, doi: null, doiLinkState: "unresolved" },
    acquisition: scope.batchID ? { state: i === 2 ? "unavailable" : "acquired", reason: i === 2 ? "SYNTHETIC held" : null, requestedFormat: "pdf" } : null,
    originals: [],
  }));
  const manifest = { schema: "litradock.research-export", schemaVersion: 1, type: format === "json" ? "document" : "manifest", generatedAt: "2026-09-13T00:00:00Z",
    scope: { kind: scope.runID ? "run" : "batch", runId: scope.runID ?? null, batchId: scope.batchID ?? null, selection: "all_saved_scope" },
    counts: { exportedRecords: records.length, scopeRecords: records.length, providerMatches: scope.runID ? 25001 : null, retrievedRecords: scope.runID ? 7 : null },
    queryContexts: [{ runId: scope.runID ?? "R1", query: 'SYNTHETIC "中文"\nα', retrievalComplete: false }] };
  return Buffer.from(format === "json" ? JSON.stringify({ ...manifest, records }) :
    [JSON.stringify(manifest), ...records.map(record => JSON.stringify({ type: "record", record }))].join("\n") + "\n", "utf8");
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [], downloads = [], posts = [], external = [];
  page.on("pageerror", error => errors.push(String(error))); page.on("download", download => downloads.push(download));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__holds = {};
    window.fetch = async (...args) => {
      const gate = String(args[0]).endsWith("/exports") ? window.__nextHold : undefined;
      if (gate) window.__nextHold = undefined;
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith("/exports") && response.ok) {
        const read = response.blob.bind(response);
        response.blob = async () => {
          const blob = await read();
          window.__lastExport = { type: blob.type, text: await blob.text() };
          return blob;
        };
      }
      if (gate) {
        const consume = response.ok ? "blob" : "text", original = response[consume].bind(response);
        response[consume] = async () => {
          const body = await original();
          await new Promise(resolve => { window.__holds[gate] = { release: resolve }; });
          window.__holds[gate].released = true;
          return body;
        };
      }
      return response;
    };
  });
  let authenticated = false, account = "A", mode = "valid";
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/service-info") return reply({ pdfEnabled: true, planEnabled: true, acquisitionEnabled: true });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (method === "POST") posts.push({ path: url.pathname, body: request.postDataJSON(), csrf: request.headers()["x-csrf"] });
    if (url.pathname === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
    if (url.pathname === "/api/login") { authenticated = true; account = request.postDataJSON().login; return reply({ csrf: "SYNTHETIC" }); }
    if (url.pathname === "/api/logout") { authenticated = false; return reply({}); }
    if (url.pathname === "/api/libraries") return reply({ items: (account === "B" ? ["LB"] : ["L1", "L2"]).map(id => ({ library_id: id, name: `SYNTHETIC ${id}` })), total: account === "B" ? 1 : 2 });
    if (/\/api\/libraries\/[^/]+$/.test(url.pathname)) return reply({ runs: [run("R1"), run("R2")], batches: [{ batch_id: "B1", state: "partial" }, { batch_id: "B2", state: "complete" }], totals: { runs: 2, batches: 2 }, offset: 0, limit: 100 });
    if (url.pathname.includes("/runs/")) {
      const offset = Number(url.searchParams.get("offset")), limit = Math.min(5, Number(url.searchParams.get("limit")));
      return reply({ run: run(url.pathname.split("/").at(-1)), records: Array.from({ length: Math.min(limit, 7 - offset) }, (_, i) => article(offset + i)), total: 7, offset, limit });
    }
    if (url.pathname.endsWith("/plans")) return reply({ plans: [], total: 0, offset: 0, limit: 25 });
    if (url.pathname.includes("/batches/")) return reply({ requestedFormat: "pdf", batch: { batch_id: url.pathname.split("/").at(-1), state: "partial", created_at: "2026-09-13" },
      items: Array.from({ length: 3 }, (_, i) => ({ search_id: `S${i}`, rank: i, state: i === 2 ? "unavailable" : "acquired", reason: i === 2 ? "SYNTHETIC held" : "", attempts: 1, article: article(i), downloadAvailable: false })),
      total: 3, counts: { acquired: 2, unavailable: 1 } });
    if (url.pathname.endsWith("/exports")) {
      const { format, ...scope } = request.postDataJSON();
      assert.deepEqual(Object.keys(scope), [scope.runID ? "runID" : "batchID"]);
      const contentType = format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8";
      if (mode === "401" || mode === "503") return reply({ error: "SYNTHETIC failure" }, Number(mode));
      if (mode === "error") return route.fulfill({ contentType, body: '{"error":"SYNTHETIC error body"}' });
      if (mode === "media") return route.fulfill({ contentType: "text/html", body: "SYNTHETIC login page" });
      return route.fulfill({ contentType, body: payload(scope, format) });
    }
    return reply({ error: "Unimplemented synthetic route" }, 404);
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const login = async who => {
    await page.getByLabel("Login", { exact: true }).fill(who);
    await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click();
    await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue(who === "B" ? "LB" : "L1");
  };
  const open = async id => {
    await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: new RegExp(`${id}$`) }) }).click();
    await expect(button("Select all")).toBeEnabled();
    await expect(button("Export saved run JSON")).toBeEnabled();
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hold = async (id, name, status = "valid") => {
    mode = status; await page.evaluate(id => { window.__nextHold = id; }, id);
    await button(name).click(); await page.waitForFunction(id => !!window.__holds[id], id);
    await expect(page.getByText(/^Preparing (saved run|batch) JSONL? export/)).toBeVisible();
    mode = "valid";
  };
  const release = async id => { await page.evaluate(id => window.__holds[id].release(), id); await settle(); };
  const download = async (scope, format) => {
    const name = `Export ${scope.runID ? "saved run" : "batch"} ${format.toUpperCase()}`;
    const event = page.waitForEvent("download"); await button(name).click(); const file = await event;
    const bytes = fs.readFileSync(await file.path());
    assert.deepEqual(bytes, payload(scope, format)); assert.equal(file.suggestedFilename(), `litradock-research.${format}`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = format === "json" ? JSON.parse(text) : JSON.parse(text.split("\n")[0]);
    const records = format === "json" ? document.records : text.trimEnd().split("\n").slice(1).map(line => JSON.parse(line).record);
    assert.equal(records.length, scope.runID ? 7 : 3); assert.equal(records[0].identifiers.pmid, "0000");
    assert.equal(records[0].identifiers.doi, "10.123/α"); assert.equal(records[0].publication.abstract, null);
    assert.equal(records[0].publication.title, 'SYNTHETIC 中文 α "quotes"\nline 0');
    assert.deepEqual(posts.at(-1).body, { ...scope, format }); assert.equal(posts.at(-1).csrf, "SYNTHETIC");
    const filename = `${result.downloads.length}-${file.suggestedFilename()}`; fs.writeFileSync(path.join(out, filename), bytes);
    result.downloads.push({ filename, bytes: bytes.length, sha256: hash(bytes), scope, format });
    await expect(button(name)).toBeEnabled();
  };
  await page.goto(origin); await login("A"); await open("R1");
  await button("Deselect all").click(); await page.locator(".result-card input").first().check();
  await button("Next records").click(); await expect(page.locator(".result-card")).toHaveCount(2);
  for (const format of ["json", "jsonl"]) await download({ runID: "R1" }, format);
  await page.getByLabel("Saved batches", { exact: true }).selectOption("B1");
  for (const format of ["json", "jsonl"]) await download({ batchID: "B1" }, format);
  result.cases.push("Both formats × run/batch: exact POST CSRF, full saved scope independent of one selected checkbox and last page; actual UTF8 device bytes, IDs/null/escaped newlines preserved");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    for (const name of ["Export saved run JSON", "Export saved run JSONL", "Export batch JSON", "Export batch JSONL"]) {
      await expect(button(name)).toBeVisible(); const box = await button(name).boundingBox(); assert(box.width > 120 && box.height >= 36);
    }
    await expect(page.locator("#run-structured-scope")).toContainText("all saved records");
    await expect(page.locator("#batch-structured-scope")).toContainText("including held outcomes");
    await page.screenshot({ path: path.join(out, `exports-${width}.png`), fullPage: true });
  }
  result.cases.push("Populated 1280/390px exports readable, actionable geometry, explicit accessible scope descriptions, no document overflow");
  for (const failure of ["media", "error", "503"]) {
    const beforeCount = downloads.length; mode = failure; await button("Export batch JSON").click();
    await expect(page.locator(".error")).toContainText(failure === "503" ? "HTTP 503" : "No file was saved");
    await expect(button("Export batch JSON")).toBeEnabled(); await settle(); assert.equal(downloads.length, beforeCount); mode = "valid";
  }
  result.cases.push("Wrong media, HTTP200 structured error and HTTP503 never download; controls recover");
  await open("R1"); await hold("checkbox-change", "Export saved run JSON");
  await button("Deselect all").click();
  const checkboxEvent = page.waitForEvent("download"); await release("checkbox-change");
  assert.deepEqual(fs.readFileSync(await (await checkboxEvent).path()), payload({ runID: "R1" }, "json"));
  await expect(button("Export saved run JSON")).toBeEnabled();
  result.cases.push("Changing checkboxes during held export neither changes full saved scope nor admits acquisition");
  // A newer held operation must remain busy even when an old response finally completes.
  for (const status of ["valid", "401", "503"]) {
    await open("R1"); const beforeCount = downloads.length;
    await hold(`old-run-${status}`, "Export saved run JSON", status); await open("R2");
    await hold(`new-run-${status}`, "Export saved run JSONL"); await release(`old-run-${status}`);
    assert.equal(downloads.length, beforeCount); await expect(button("Export saved run JSONL")).toBeDisabled();
    await expect(page.locator(".error")).toHaveCount(0);
    const event = page.waitForEvent("download"); await release(`new-run-${status}`); const file = await event;
    assert.deepEqual(fs.readFileSync(await file.path()), payload({ runID: "R2" }, "jsonl"));
    await expect(button("Export saved run JSONL")).toBeEnabled();
  }
  result.cases.push("Held old-run HTTP200/401/503 cannot save/expire/error/clear newer busy; each newer held JSONL completes with exact bytes");
  for (const format of ["json", "jsonl"]) {
    await page.getByLabel("Saved batches", { exact: true }).selectOption("B1");
    const beforeCount = downloads.length; await hold(`library-${format}`, `Export batch ${format.toUpperCase()}`);
    const target = await page.getByLabel("Choose library", { exact: true }).inputValue() === "L1" ? "L2" : "L1";
    await page.getByLabel("Choose library", { exact: true }).selectOption(target); await release(`library-${format}`);
    await open("R1"); assert.equal(downloads.length, beforeCount); await download({ runID: "R1" }, format);
  }
  result.cases.push("Both held batch formats discarded across library changes; new library exports work");
  await page.getByLabel("Saved batches", { exact: true }).selectOption("B1");
  const beforeBatch = downloads.length; await hold("old-batch", "Export batch JSON");
  await page.getByLabel("Saved batches", { exact: true }).selectOption("B2"); await release("old-batch");
  await expect(button("Export batch JSON")).toBeEnabled(); assert.equal(downloads.length, beforeBatch); await download({ batchID: "B2" }, "json");
  const beforeAccount = downloads.length; await hold("old-account", "Export batch JSONL", "401");
  await button("Sign out").click(); await login("B"); await release("old-account"); await open("R1");
  assert.equal(downloads.length, beforeAccount); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue("LB"); await download({ runID: "R1" }, "jsonl");
  result.cases.push("Batch navigation retires old save; logout/relogin B discards old held401 and B remains usable");
  mode = "401"; const beforeExpiry = downloads.length; await button("Export saved run JSON").click();
  await expect(page.getByLabel("Login", { exact: true })).toBeVisible(); assert.equal(await page.locator(".result-card,.batch-item").count(), 0);
  mode = "valid"; await login("B"); await open("R1"); assert.equal(downloads.length, beforeExpiry); await download({ runID: "R1" }, "json");
  result.cases.push("Current401 removes private records/batch and permits relogin plus a valid export");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(posts.filter(post => /\/(search|batches|plans)$/.test(post.path)).length, 0);
  result.after = { source: treeHashes("src"), dist: treeHashes("dist") }; assert.deepEqual(result.after, before);
  result.pass = true;
} catch (error) {
  result.pass = false; result.error = String(error); process.exitCode = 1;
  if (page) { result.alerts = await page.locator(".error").allTextContents(); result.lastSyntheticResponse = await page.evaluate(() => window.__lastExport); await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }); }
}
finally {
  if (browser) await browser.close(); await new Promise(resolve => server.httpServer.close(resolve));
  result.serverClosed = true; result.driverSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, receipt: out }, null, 2));
}
