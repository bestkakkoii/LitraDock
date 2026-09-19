// SYNTHETIC independent loopback service; compiled UI only, never live provider evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../../../tests/native-browser/node_modules/fflate/esm/index.mjs";
import { showWorkspace, openDisclosure, setSavedCheck } from "./workspace-navigation.mjs";

const out = path.resolve(".litradock/runtime/native023a", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const assets = new Map(fs.readdirSync("dist", { recursive: true }).filter(f => fs.statSync(path.join("dist", f)).isFile())
  .map(f => [`/${f.replaceAll("\\", "/")}`, fs.readFileSync(path.join("dist", f))]));
const result = { scope: "SYNTHETIC independent loopback selection/export model; no backend, PostgreSQL, provider or PDF acquisition", assets: Object.fromEntries([...assets].map(([f, b]) => [f, digest(b)])), checks: [], downloads: [], errors: [], external: [] };
const sizes = [0, 1, 99, 100, 101, 999, 1000];
const article = i => ({ SearchId: `SYNTHETIC-${String(i).padStart(4, "0")}`, Title: `SYNTHETIC α 中文 record ${i}`,
  Pmid: `SYNTHETIC-PMID-${i}`, Pmcid: `SYNTHETIC-PMCID-${i}`, Doi: `SYNTHETIC-DOI-${i}`, OriginalUri: `https://source.example.invalid/${i}` });
const runs = new Map(sizes.map(n => [`R${n}`, { run_id: `R${n}`, input: `SYNTHETIC ${n} saved records`, total: 25001, fetched: n, state: "partial" }]));
const saved = new Map(), posts = [], exportBodies = [], planBodies = [], holds = new Map();
let selectionReads = 0;
let fault = "", holdStatus = 200, losePlan = true, capturedPlan = null, writesEnabled = true, readEnabled = true;
function state(account, library, id) {
  const key = `${account}:${library}:${id}`;
  if (!saved.has(key)) saved.set(key, { revision: 50, defaultSelected: true, choices: new Map(), receipts: new Map(), count: runs.get(id).fetched });
  const s = saved.get(key), count = runs.get(id).fetched;
  if (s.count !== count) { s.count = count; s.revision++; }
  return s;
}
function projection(account, library, id) {
  const s = state(account, library, id), records = Array.from({ length: s.count }, (_, i) => article(i));
  const selected = records.filter(a => s.choices.get(a.SearchId) ?? s.defaultSelected);
  return { runID: id, revision: s.revision, defaultSelected: s.defaultSelected, savedCount: records.length,
    selectedCount: selected.length, selectedIDs: selected.map(a => a.SearchId), selectedRecords: selected.length <= 100 ? selected : [],
    recordsComplete: selected.length <= 100, recordsReason: selected.length <= 100 ? "" : "SYNTHETIC selected details exceed the 100-record PDF/snapshot limit.",
    canEdit: writesEnabled, selectionLimit: 1000, detailLimit: 100 };
}
const planID = `PLN-${"3".repeat(32)}`;
const plan = () => ({ planID, runID: "R100", selectedCount: capturedPlan?.searchIDs.length ?? 0, state: "complete", createdAt: "2026-09-19", updatedAt: "2026-09-19", revision: 1,
  allowedActions: [], counts: { waiting: 0, queued: 0, running: 0, completed: 0, held: capturedPlan?.searchIDs.length ?? 0, retry: 0, paused: 0, cancelled: 0 },
  admission: { admittedCount: 0, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 0 });
function exportBytes(runID, selected, format, selection) {
  const records = selected.map(id => ({ searchId: id, runIds: [runID], identifiers: { pmid: `SYNTHETIC-${id}`, pmcid: null, doi: null }, publication: { title: "SYNTHETIC α 中文" }, sourceLinks: { pubmed: `https://source.example.invalid/${id}` }, originals: [] }));
  const scope = { kind: "run", runId: runID, batchId: null, selection: selection ? "selected_saved_records" : "all_saved_scope",
    ...(selection ? { selectionRevision: selection.revision, savedRecords: selection.savedCount } : {}) };
  // Column names are synthetic transport fixtures; the backend owns native serialization.
  const table = [["Search ID", "Search Run ID", "Title", ...(selection ? ["Selection", "Selection Revision", "Saved Record Count"] : [])],
    ...selected.map(id => [id, runID, "SYNTHETIC α 中文", ...(selection ? ["selected_saved_records", String(selection.revision), String(selection.savedCount)] : [])])];
  if (format === "csv") return Buffer.from(table.map(row => row.join(",")).join("\r\n") + "\r\n");
  if (format === "xlsx") {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${table.map((row, i) => `<row r="${i + 1}">${row.map(value => `<c t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
    return Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": Buffer.from(xml), "SYNTHETIC.txt": Buffer.from("Isolated metadata transport fixture, not a native XLSX serializer qualification.") }, { level: 0, mtime: new Date("2026-09-19T00:00:00Z") }));
  }
  const envelope = { schema: "litradock.research-export", schemaVersion: 1, type: format === "json" ? "document" : "manifest", scope,
    counts: { exportedRecords: records.length, scopeRecords: records.length }, queryContexts: [{ runId: runID, query: runs.get(runID).input }] };
  return Buffer.from(format === "json" ? JSON.stringify({ ...envelope, records }) : [JSON.stringify(envelope), ...records.map(record => JSON.stringify({ type: "record", record }))].join("\n") + "\n");
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"), route = url.pathname;
    const reply = (value, status = 200, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(value)); };
    const staticPath = route === "/" ? "/index.html" : route;
    if (assets.has(staticPath)) { res.writeHead(200, { "Content-Type": route.endsWith(".js") ? "text/javascript" : route.endsWith(".css") ? "text/css" : "text/html" }); return res.end(assets.get(staticPath)); }
    if (route === "/favicon.ico") { res.writeHead(204); return res.end(); }
    let raw = ""; for await (const bytes of req) raw += bytes;
    const body = raw ? JSON.parse(raw) : null, account = /synthetic=(A|B)/.exec(req.headers.cookie ?? "")?.[1];
    if (route === "/api/login") return reply({ csrf: "SYNTHETIC" }, 200, { "Set-Cookie": `synthetic=${body.login}; Path=/; HttpOnly; SameSite=Strict` });
    if (route === "/api/logout") return reply({}, 200, { "Set-Cookie": "synthetic=; Max-Age=0; Path=/" });
    if (!account) return reply({ error: "SYNTHETIC anonymous" }, 401);
    if (route === "/api/session") return reply({ csrf: "SYNTHETIC" });
    if (route === "/service-info") return reply({ durableSelectionEnabled: readEnabled, selectionWriteEnabled: writesEnabled, selectionRecordLimit: 1000,
      searchEnabled: true, planEnabled: true, savedSetEnabled: true, pdfEnabled: true, acquisitionEnabled: true });
    if (route === "/api/libraries") return reply({ items: ["L1", "L2"].map(library_id => ({ library_id, name: `SYNTHETIC ${library_id}` })), total: 2 });
    const library = route.split("/")[3];
    if (/^\/api\/libraries\/L[12]$/.test(route)) return reply({ runs: [...runs.values()], batches: [], totals: { runs: runs.size, batches: 0 }, offset: 0, limit: 100 });
    if (route.endsWith("/search")) { runs.set("RNEW", { run_id: "RNEW", input: body.query, total: 0, fetched: 0, state: "complete" }); return reply({ id: "RNEW" }); }
    if (route.endsWith("/selection")) {
      const id = route.split("/").at(-2), s = state(account, library, id);
      if (req.method === "GET") {
        selectionReads++;
        const value = projection(account, library, id);
        if (fault === "hold-read") { fault = ""; res.writeHead(holdStatus, { "Content-Type": "application/json" }); res.flushHeaders(); holds.set("read", () => res.end(JSON.stringify(holdStatus === 200 ? value : { error: "SYNTHETIC stale session" }))); return; }
        return reply(value);
      }
      assert.equal(req.headers["x-csrf"], "SYNTHETIC"); posts.push({ account, library, id, body: structuredClone(body) });
      if (fault === "reject") { fault = ""; return reply({ error: "SYNTHETIC denied" }, 403); }
      const previous = s.receipts.get(body.requestID);
      if (previous) return reply(previous.raw === raw ? previous.value : {}, previous.raw === raw ? 200 : 409);
      if (body.revision !== s.revision) return reply({ error: "SYNTHETIC conflict" }, 409);
      const members = new Set(Array.from({ length: s.count }, (_, i) => article(i).SearchId));
      if (body.action === "set") {
        assert(body.ids.length >= 1 && body.ids.length <= 100); assert.equal(new Set(body.ids).size, body.ids.length);
        assert(body.ids.every(id => members.has(id))); assert.equal(typeof body.selected, "boolean");
        body.ids.forEach(id => s.choices.set(id, body.selected));
      } else { assert(["all", "none"].includes(body.action)); assert.equal(body.ids, undefined); assert.equal(body.selected, undefined); s.defaultSelected = body.action === "all"; s.choices.clear(); }
      const value = { runID: id, requestID: body.requestID, revision: ++s.revision }; s.receipts.set(body.requestID, { raw, value });
      if (fault === "lost") { fault = ""; return reply({}); }
      if (fault === "hold-write") { fault = ""; holds.set("write", () => reply(value)); return; }
      return reply(value);
    }
    if (route.includes("/runs/")) {
      const id = route.split("/").at(-1), run = runs.get(id), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return reply({ run, total: run.fetched, offset, limit, records: Array.from({ length: Math.max(0, Math.min(limit, run.fetched - offset)) }, (_, i) => article(offset + i)) });
    }
    if (route.endsWith("/plans") && req.method === "POST") {
      planBodies.push(structuredClone(body)); if (!capturedPlan) capturedPlan = structuredClone(body);
      else assert.deepEqual(body, capturedPlan);
      if (losePlan) { losePlan = false; return reply({}); }
      return reply({ planID, revision: 1, state: "active", selectedCount: capturedPlan.searchIDs.length, affectedCount: 0 });
    }
    if (route.endsWith("/plans")) return reply({ plans: capturedPlan ? [plan()] : [], total: capturedPlan ? 1 : 0, offset: 0, limit: 25 });
    if (route.includes("/plans/")) {
      const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      return reply({ plan: plan(), total: capturedPlan.searchIDs.length, offset, limit, nextPollAfterMs: 2000,
        items: capturedPlan.searchIDs.slice(offset, offset + limit).map((id, i) => ({ searchID: id, rank: offset + i + 1, childBatchID: null,
          phase: "held", acquisitionState: null, reason: "SYNTHETIC no acquisition", attempts: 0, retryEligible: false, downloadAvailable: false, article: { SearchId: id, Title: "SYNTHETIC" } })) });
    }
    if (route.endsWith("/exports")) {
      exportBodies.push(structuredClone(body)); const runID = body.RunID ?? body.runID, format = body.Format ?? body.format;
      const p = projection(account, library, runID), selected = body.Selection === "selected";
      if (selected && body.SelectionRevision !== p.revision) return reply({ error: "SYNTHETIC export conflict" }, 409);
      const ids = selected ? p.selectedIDs : Array.from({ length: p.savedCount }, (_, i) => article(i).SearchId);
      assert(ids.length > 0 && ids.length <= 1000);
      const bytes = exportBytes(runID, ids, format, selected ? p : null);
      res.writeHead(200, { "Content-Type": ({ csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", json: "application/json", jsonl: "application/x-ndjson" })[format],
        "X-LitraDock-Export-Scope": selected ? "selected_saved_records" : "all_saved_scope", "X-LitraDock-Selection-Revision": String(p.revision), "X-LitraDock-Export-Count": String(ids.length) });
      return res.end(bytes);
    }
    result.errors.push(`Unexpected local route ${req.method} ${route}`); return reply({}, 404);
  } catch (error) { result.errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }); result.browser = browser.version();
  for (const viewport of [{ width: 1365, height: 833 }, { width: 390, height: 844 }]) {
    saved.clear(); capturedPlan = null; losePlan = true; planBodies.length = 0;
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { result.external.push(route.request().url()); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", e => result.errors.push(String(e)));
    const button = name => page.getByRole("button", { name, exact: true }), area = page.getByRole("region", { name: "Saved record selection" });
    const ready = () => expect(button("Select all saved")).toBeEnabled();
    const count = (n, total) => expect(area).toContainText(`${n} selected of ${total} saved`);
    const action = async name => {
      if (["Reload saved selection", "Select page", "Deselect page"].includes(name) && !await button(name).isVisible()) await openDisclosure(area, "Selection scope");
      await button(name).click(); await ready();
      if (await area.locator("details").evaluate(e => e.open)) await area.locator("summary").click();
    };
    const open = async id => { await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: new RegExp(` ${id}$`) }) }).click(); await ready(); };
    const login = async who => { await page.getByLabel("Login", { exact: true }).fill(who); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click(); await expect(page.getByLabel("Choose library")).toHaveValue("L1"); };
    await page.goto(origin); await login("A");
    for (const n of sizes) {
      await open(`R${n}`); await count(n, n); await expect(page.locator(".result-card")).toHaveCount(Math.min(25, n));
      if (n > 100) await expect(button(`Download PDFs (${n} selected)`)).toBeDisabled();
      await action("Deselect all"); await count(0, n);
      if (!n) {
        await openDisclosure(page, "Export saved results and other actions");
        for (const format of ["CSV", "XLSX", "JSON", "JSONL"]) await expect(button(`Export selected ${format}`)).toBeDisabled();
      }
      if (n) {
        await action("Select page"); await count(Math.min(25, n), n);
        await setSavedCheck(page.locator(".result-card input").first(), false); await count(Math.min(25, n) - 1, n);
        if (n > 25) { await button("Next records").click(); await action("Select page"); await count(49, n); await action("Deselect page"); await count(24, n); }
      }
      const beforeReload = posts.length, expected = Math.max(0, Math.min(n, 25) - 1);
      await page.reload(); await ready(); await count(expected, n); assert.equal(posts.length, beforeReload);
      await action("Select all saved"); await count(n, n);
      result.checks.push({ viewport, size: n, passed: "server counts/full compact IDs, bounded details, all/none/page/individual, pagination, reload GET only" });
    }
    await open("R1000"); await setSavedCheck(page.locator(".result-card input").first(), false); await count(999, 1000);
    await openDisclosure(page, "Export saved results and other actions");
    for (const selected of [false, true]) for (const format of ["csv", "xlsx", "json", "jsonl"]) {
      const p = projection("A", "L1", "R1000"), ids = selected ? p.selectedIDs : Array.from({ length: 1000 }, (_, i) => article(i).SearchId);
      const event = page.waitForEvent("download"); await button(`Export ${selected ? "selected" : ["json", "jsonl"].includes(format) ? "saved run" : "saved"} ${format.toUpperCase()}`).click();
      const download = await event, bytes = fs.readFileSync(await download.path());
      assert.deepEqual(bytes, exportBytes("R1000", ids, format, selected ? p : null));
      if (format === "xlsx") {
        const rows = [...Buffer.from(unzipSync(bytes)["xl/worksheets/sheet1.xml"]).toString().matchAll(/<row[^>]*>(.*?)<\/row>/g)]
          .map(row => [...row[1].matchAll(/<t>(.*?)<\/t>/g)].map(cell => cell[1]));
        assert.deepEqual(rows.slice(1).map(row => row[0]), ids);
        if (selected) { assert.deepEqual(rows[0].slice(3), ["Selection", "Selection Revision", "Saved Record Count"]); rows.slice(1).forEach(row => assert.deepEqual(row.slice(3), ["selected_saved_records", String(p.revision), "1000"])); }
      }
      assert(download.suggestedFilename().includes(selected ? "selected-" : "saved-"));
      if (selected) assert.deepEqual(exportBodies.at(-1), { RunID: "R1000", Selection: "selected", SelectionRevision: p.revision, Format: format });
      else assert.deepEqual(exportBodies.at(-1), { runID: "R1000", format });
      result.downloads.push({ viewport, scope: selected ? "selected" : "saved", format, count: ids.length, bytes: bytes.length, sha256: digest(bytes) });
    }
    await open("R99"); fault = "hold-write"; await button("Deselect all").click();
    await expect.poll(() => holds.has("write")).toBe(true); await expect(button("Select all saved")).toBeDisabled(); await count(99, 99);
    holds.get("write")(); holds.delete("write"); await ready(); await count(0, 99);
    fault = "lost"; await button("Select all saved").click(); await expect(button("Retry same selection change")).toBeVisible();
    const lostBody = posts.at(-1).body; await button("Retry same selection change").click(); await ready(); await count(99, 99); assert.deepEqual(posts.at(-1).body, lostBody);
    fault = "lost"; await button("Deselect all").click(); await expect(button("Retry same selection change")).toBeVisible();
    const pendingBody = posts.at(-1).body; await open("R1"); await showWorkspace(page, "Saved searches");
    await page.locator(".history-entry").filter({ has: page.locator(".history-id", { hasText: / R99$/ }) }).click();
    await expect(button("Retry same selection change")).toBeVisible(); await button("Retry same selection change").click(); await ready(); assert.deepEqual(posts.at(-1).body, pendingBody); await count(0, 99);
    fault = "lost"; await button("Select all saved").click(); await expect(button("Retry same selection change")).toBeVisible();
    const beforeLostReload = posts.length; await page.reload(); await ready(); await count(99, 99); assert.equal(posts.length, beforeLostReload);
    fault = "reject"; await button("Deselect all").click(); await expect(area).toContainText("was rejected"); await count(99, 99);
    await expect(button("Retry same selection change")).toHaveCount(0); await action("Reload saved selection");
    // Real concurrent tabs use independent rendered revisions of one fixture account.
    const other = await context.newPage(); await other.goto(page.url()); await showWorkspace(other, "Saved searches");
    await other.locator(".history-entry").filter({ has: other.locator(".history-id", { hasText: / R99$/ }) }).click(); await expect(other.getByRole("button", { name: "Select all saved", exact: true })).toBeEnabled();
    await other.getByRole("button", { name: "Deselect all", exact: true }).click(); await expect(other.locator(".selection-toolbar")).toContainText("0 selected of 99");
    await openDisclosure(page, "Export saved results and other actions");
    let unexpectedDownloads = 0; const onDownload = () => unexpectedDownloads++; page.on("download", onDownload);
    await button("Export selected JSON").click(); await expect(page.getByRole("alert").filter({ hasText: "saved selection changed" })).toBeVisible();
    assert.equal(unexpectedDownloads, 0); page.off("download", onDownload);
    await button("Deselect all").click(); await expect(area).toContainText("could not be applied"); assert.equal(projection("A", "L1", "R99").selectedCount, 0);
    await action("Reload saved selection"); await count(0, 99); await action("Select page"); await count(25, 99); await other.close();
    const beforeSameRunReopen = posts.length;
    const newerChoices = state("A", "L1", "R99"); newerChoices.defaultSelected = false; newerChoices.choices.clear(); newerChoices.revision++;
    await open("R99"); await count(0, 99); assert.equal(posts.length, beforeSameRunReopen);
    await action("Select page"); await count(25, 99);
    // Continuation membership follows default/exception policy and increments revision.
    runs.get("R99").fetched = 100; await action("Reload saved selection"); await count(25, 100);
    await action("Select all saved"); await setSavedCheck(page.locator(".result-card input").first(), false);
    runs.get("R99").fetched = 101; await action("Reload saved selection"); await count(100, 101); runs.get("R99").fetched = 99;
    // Existing plan intent is copied at submission and remains immutable after selection edits.
    await open("R100"); await showWorkspace(page, "Research plans"); await button("Create processing plan (100/100)").click();
    await expect(button("Retry same submission")).toBeVisible(); const immutable = structuredClone(planBodies.at(-1));
    await showWorkspace(page, "Search & PDFs"); await action("Deselect all"); await showWorkspace(page, "Research plans");
    await button("Retry same submission").click(); await expect(page.getByRole("heading", { name: `Plan ${planID}`, exact: true })).toBeVisible(); assert.deepEqual(planBodies.at(-1), immutable); assert.equal(immutable.searchIDs.length, 100);
    await open("R1"); await setSavedCheck(page.locator(".result-card input").first(), false);
    const navigationPosts = posts.length; await page.getByLabel("Choose library").selectOption("L2"); await open("R1"); await count(1, 1);
    await page.getByLabel("Choose library").selectOption("L1"); await open("R1"); await count(0, 1); assert.equal(posts.length, navigationPosts);
    // Hold old read bodies across a new authenticated session; no stale 401 logout.
    for (const status of [200, 401]) {
      fault = "hold-read"; holdStatus = status; await openDisclosure(area, "Selection scope"); await button("Reload saved selection").click(); await expect.poll(() => holds.has("read")).toBe(true);
      await button("Sign out").click(); await login("B"); await open("R1"); await count(1, 1);
      holds.get("read")(); holds.delete("read"); await expect(button("Sign out")).toBeVisible(); await action("Reload saved selection"); await count(1, 1);
      await button("Sign out").click(); await login("A"); await open("R1"); await count(0, 1);
    }
    const beforeSearch = posts.length; await page.getByLabel("Search PubMed", { exact: true }).fill("SYNTHETIC new empty search"); await button("Search PubMed").click(); await ready(); await count(0, 0); assert.equal(posts.length, beforeSearch);
    await open("R1000"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(out, `${viewport.width}-selection.png`) });
    writesEnabled = false; await page.reload(); await expect(area).toContainText("changes are currently disabled");
    await expect(button("Select all saved")).toBeDisabled(); await expect(page.locator(".result-card input").first()).toBeDisabled();
    readEnabled = false; const readsBeforeDisabled = selectionReads; await page.reload(); await expect(area).toContainText("unavailable on this server");
    assert.equal(selectionReads, readsBeforeDisabled); writesEnabled = readEnabled = true;
    result.checks.push({ viewport, passed: "saved/selected exact metadata exports, delayed/lost/same-UUID retry, navigation journal, two-tab revision conflict, rejection, continuation policies, immutable 100-member plan, library/account/stale 401 fences, new search GET-only cleanup, no overflow" });
    await context.close();
  }
  assert.deepEqual(result.external, []); assert.deepEqual(result.errors, []); result.pass = true;
} catch (error) { result.pass = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally { holds.forEach(release => release()); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ out, pass: result.pass, checks: result.checks.length, downloads: result.downloads.length, error: result.error }, null, 2)); }
