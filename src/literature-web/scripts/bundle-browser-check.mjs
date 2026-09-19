// SYNTHETIC fixed compiled UI and independently paced loopback HTTP only.
// No native handler, PostgreSQL, provider, public runtime or clinical data.
import { setSavedCheck, createSelectionFixture, showWorkspace } from "./workspace-navigation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { chromium, expect } from "@playwright/test";
import { zipSync, unzipSync } from "../../../tests/native-browser/node_modules/fflate/esm/index.mjs";
import { fixtureDocument, fixturePlan } from "../src/bundles/fixtures.ts";

const selectionFixture = createSelectionFixture();
const root = process.cwd(), out = path.join(root, ".litradock/runtime/frontend018", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hashes = dir => Object.fromEntries(fs.readdirSync(path.join(root, dir), { recursive: true }).filter(f => fs.statSync(path.join(root, dir, f)).isFile()).sort()
  .map(f => [f.replaceAll("\\", "/"), hash(fs.readFileSync(path.join(root, dir, f)))]));
const before = { source: hashes("src"), dist: hashes("dist") };
const fixedAssets = new Map(Object.keys(before.dist).map(f => [f, fs.readFileSync(path.join(root, "dist", f))]));
const result = { scope: "SYNTHETIC fixed compiled UI / paced HTTP / real browser device files only", before, cases: [], downloads: [], requests: [] };
const originals = [0, 1].map(n => Buffer.from(`<article synthetic="true">SYNTHETIC 中文 α ${n}\n${"x".repeat(4 * 1024 * 1024 + 128)}</article>`));
const input = originals.map(b => ({ bytes: b.length, sha256: hash(b), zipBytes: 1, zipHash: "0".repeat(64) }));
const d = fixtureDocument(input), zips = [];
for (const part of d.parts) {
  const body = { schema: "litradock.bundle-part", schemaVersion: 1, snapshotID: d.snapshotID, partNumber: part.number, files: part.files,
    members: d.manifest.items.filter(i => part.files.some(f => f.searchIDs.includes(i.searchId))) };
  const zip = Buffer.from(zipSync({ [part.files[0].file]: originals[part.number - 1], "manifest.json": Buffer.from(JSON.stringify(body)) }, { level: 0, mtime: new Date("2026-09-13T00:00:00Z") }));
  part.bytes = zip.length; part.sha256 = hash(zip); zips.push(zip);
}
const unavailable = fixtureDocument(); unavailable.snapshotID = `BND-${"c".repeat(32)}`;
const alt = structuredClone(d); alt.snapshotID = `BND-${"b".repeat(32)}`;
// Alternate snapshots are used for held manifest tests only; parts never served.
const documents = [d, alt, unavailable];
const summary = doc => ({ snapshotID: doc.snapshotID, planID: doc.planID, createdAt: doc.createdAt, expiresAt: doc.expiresAt,
  partCount: doc.parts.length, members: doc.manifest.counts.members, originalBytes: doc.manifest.counts.originalBytes });
const plan = { ...fixturePlan, requestedFormat: "xml", revision: 2, state: "complete", createdAt: d.createdAt, updatedAt: d.createdAt, allowedActions: [],
  counts: { waiting: 0, queued: 0, running: 0, completed: 2, held: 1, retry: 0, paused: 0, cancelled: 0 },
  admission: { admittedCount: 3, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 0 };
const run = { run_id: fixturePlan.runID, input: 'SYNTHETIC ("中文"[MeSH Terms] AND α) OR "long Boolean search"', total: 25001, fetched: 3, state: "partial" };
const article = n => ({ SearchId: `SYNTHETIC-S${n}`, Title: d.manifest.research.records[n].publication.title, Pmid: `000${n}`, Doi: "10.123/α" });
let mode = "valid", authenticated = false, account = "A", enabled = true, hold = null;
const prepareBodies = [], external = [], errors = [], downloads = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1"), pathname = url.pathname;
  let raw = ""; for await (const chunk of req) raw += chunk;
  const reply = (value, status = 200, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(value)); };
  try {
    if (pathname === "/service-info") return reply({ durableSelectionEnabled: true, selectionWriteEnabled: true, selectionRecordLimit: 1000, bundleDeliveryEnabled: enabled, planEnabled: false, acquisitionEnabled: false, pdfEnabled: false });
    if (pathname === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
    if (pathname === "/api/login") { authenticated = true; account = JSON.parse(raw).login; return reply({ csrf: "SYNTHETIC" }); }
    if (pathname === "/api/logout") { authenticated = false; return reply({}); }
    if (pathname === "/api/libraries") return reply({ items: (account === "B" ? ["LB"] : ["L1", "L2"]).map(id => ({ library_id: id, name: `SYNTHETIC ${id}` })), total: account === "B" ? 1 : 2 });
    if (/^\/api\/libraries\/[^/]+$/.test(pathname)) return reply({ runs: [run], batches: [], totals: { runs: 1, batches: 0 }, offset: 0, limit: 100 });
    if (pathname.endsWith("/selection")) {
      const selectionRun = pathname.split("/").at(-2);
      return selectionFixture(pathname, selectionRun, [article(0), article(1), article(2)], req.method, req.method === "POST" ? JSON.parse(raw) : null, reply);
    }
    if (pathname.includes("/runs/")) return reply({ run, records: [article(0), article(1), article(2)], total: 3, offset: 0, limit: 25 });
    if (pathname.endsWith("/plans")) return reply({ plans: [plan], total: 1, offset: 0, limit: 25 });
    if (pathname.endsWith(`/plans/${plan.planID}`)) return reply({ plan, items: [{ searchID: "SYNTHETIC-S2", rank: 3, phase: "held", childBatchID: null, acquisitionState: "unavailable", reason: "SYNTHETIC rights held", attempts: 1, retryEligible: false, downloadAvailable: false, article: article(2) }], total: 3, offset: 0, limit: 25, nextPollAfterMs: 2000, policy: "SYNTHETIC" });
    if (pathname.endsWith("/bundles")) {
      if (req.method === "POST") {
        assert.equal(req.headers["x-csrf"], "SYNTHETIC"); prepareBodies.push(raw); assert.deepEqual(Object.keys(JSON.parse(raw)), ["requestID"]);
        if (mode === "receipt-shape") return reply({});
        if (mode === "receipt503") return reply({ error: "SYNTHETIC uncertain admission" }, 503);
        return reply(d);
      }
      return reply({ items: documents.map(summary), total: documents.length });
    }
    if (pathname.includes("/bundles/")) {
      const id = pathname.split("/bundles/")[1].split("/")[0], document = documents.find(d => d.snapshotID === id);
      if (!document) return reply({}, 404);
      if (!pathname.includes("/parts/")) {
        if (mode === "detail503") return reply({}, 503);
        if (mode.startsWith("held")) {
          const status = Number(mode.slice(4)); mode = "valid";
          const body = Buffer.from(JSON.stringify(status === 200 ? document : {}));
          res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length }); res.write(body.subarray(0, 1));
          await new Promise(resolve => { hold = () => { if (!res.destroyed) res.end(body.subarray(1)); hold = null; resolve(); }; res.on("close", resolve); }); return;
        }
        return reply(document);
      }
      const n = Number(pathname.split("/").at(-1)), part = d.parts[n - 1], zip = zips[n - 1];
      let start = 0;
      if (req.headers.range) { assert.equal(req.headers["if-match"], `"${part.sha256}"`); const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range); assert.ok(match); start = Number(match[1]); assert.equal(Number(match[2]), zip.length - 1); }
      result.requests.push({ path: pathname, range: req.headers.range ?? null, ifMatch: req.headers["if-match"] ?? null, mode });
      if (["409", "410", "412", "416", "429", "503", "401"].includes(mode)) return reply({}, Number(mode), mode === "429" ? { "Retry-After": "2" } : {});
      const headers = { "Content-Type": "application/zip", "Accept-Ranges": "bytes", ETag: mode === "etag" ? '"wrong"' : `"${part.sha256}"`, "Content-Length": zip.length - start,
        ...(start ? { "Content-Range": mode === "range" ? "bytes 0-1/2" : `bytes ${start}-${zip.length - 1}/${zip.length}` } : {}) };
      res.writeHead(start ? 206 : 200, headers);
      if (mode === "hash") { const changed = Buffer.from(zip.subarray(start)); changed[0] ^= 1; return res.end(changed); }
      if (mode === "paced" || mode === "interrupt") {
        const currentMode = mode; res.write(zip.subarray(start, start + 4096));
        await new Promise(resolve => { hold = () => { if (!res.destroyed) currentMode === "interrupt" ? res.destroy() : res.end(zip.subarray(start + 4096)); hold = null; resolve(); }; res.on("close", resolve); }); return;
      }
      return res.end(zip.subarray(start));
    }
    if (pathname.startsWith("/api/")) return reply({ error: "SYNTHETIC route absent" }, 404);
    const name = pathname === "/" ? "index.html" : pathname.slice(1), data = fixedAssets.get(name);
    if (!data) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" }); res.end(data);
  } catch (e) { errors.push(String(e)); if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const checkDownload = async (download, kind, n = 0) => {
  const data = fs.readFileSync(await download.path());
  if (kind === "zip") {
    assert.deepEqual(data, zips[n - 1]); assert.equal(hash(data), d.parts[n - 1].sha256);
    const entries = unzipSync(data), manifest = JSON.parse(Buffer.from(entries["manifest.json"]));
    assert.equal(manifest.schema, "litradock.bundle-part"); assert.equal(manifest.snapshotID, d.snapshotID); assert.equal(manifest.partNumber, n);
    assert.deepEqual(Object.keys(entries).sort(), ["manifest.json", d.parts[n - 1].files[0].file].sort());
    assert.deepEqual(Buffer.from(entries[d.parts[n - 1].files[0].file]), originals[n - 1]);
    assert.deepEqual(manifest.files[0].searchIDs, [`SYNTHETIC-S${n - 1}`]);
  } else {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    assert.equal(parsed.manifest.counts.members, 3); assert.deepEqual(parsed.manifest.items.map(i => i.searchId), ["SYNTHETIC-S0", "SYNTHETIC-S1", "SYNTHETIC-S2"]);
    assert.equal(parsed.manifest.research.records[0].identifiers.doi, "10.123/α");
    assert.deepEqual(data, Buffer.from(JSON.stringify(parsed.snapshotID === unavailable.snapshotID ? unavailable : d)));
  }
  const filename = `${result.downloads.length}-${download.suggestedFilename()}`; fs.copyFileSync(await download.path(), path.join(out, filename));
  result.downloads.push({ filename, bytes: data.length, sha256: hash(data), kind, part: n });
};
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version(); page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(String(e))); page.on("download", file => downloads.push(file));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const button = name => page.getByRole("button", { name, exact: true });
  const area = page.getByRole("region", { name: "Partitioned original downloads" });
  const login = async who => { await page.getByLabel("Login", { exact: true }).fill(who); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click(); await expect(page.getByLabel("Choose library", { exact: true })).toHaveValue(who === "B" ? "LB" : "L1"); };
  const openPlan = async () => { await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").first().click(); await expect(button("Select all saved")).toBeEnabled(); await showWorkspace(page, "Research plans"); await page.getByLabel("Saved plans", { exact: true }).selectOption(plan.planID); await expect(button("Prepare download parts")).toBeEnabled(); };
  const openSnapshot = async id => { await page.getByLabel("Saved download snapshots", { exact: true }).selectOption(id); await expect(button("Save bundle manifest")).toBeEnabled(); };
  const waitBytes = async () => { await expect(area.getByRole("status").filter({ hasText: /4,096 \/ .*bytes/ })).toBeVisible(); };
  const getDownload = async action => { const promise = page.waitForEvent("download"); await action(); return await promise; };
  await page.goto(origin); await login("A"); await openPlan(); assert.equal(prepareBodies.length, 0);
  mode = "receipt-shape"; await button("Prepare download parts").click(); await expect(button("Retry same preparation request")).toBeEnabled();
  mode = "receipt503"; await button("Retry same preparation request").click(); await expect(button("Retry same preparation request")).toBeEnabled();
  assert.equal(prepareBodies[0], prepareBodies[1]); mode = "valid"; await button("Retry same preparation request").click(); await expect(button("Save bundle manifest")).toBeEnabled();
  assert.equal(prepareBodies[1], prepareBodies[2]); result.cases.push("malformed200 and uncertain503 preserve exact UUID/body; explicit replay only");
  await checkDownload(await getDownload(() => button("Save bundle manifest").click()), "json");
  await button("Deselect all parts").click(); await expect(button("Download selected parts")).toBeDisabled();
  await area.getByLabel("Part 1", { exact: true }).focus(); await page.keyboard.press("Space"); await expect(area.getByText("1 of 2 parts selected", { exact: true })).toBeVisible();
  await button("Select all parts").click();
  const baseDownloads = downloads.length;
  await button("Download selected parts").click(); await expect.poll(() => downloads.length).toBe(baseDownloads + 2);
  await checkDownload(downloads[baseDownloads], "zip", 1); await checkDownload(downloads[baseDownloads + 1], "zip", 2);
  result.cases.push("default/keyboard/deselect/all-part selection; sequential actual ZIP files validated");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await area.getByText("Unresolved records and source links (1)", { exact: true }).click();
    const geometry = await area.evaluate(el => ({ width: el.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      paragraphs: [...el.querySelectorAll("p")].filter(p => p.getBoundingClientRect().height).map(p => ({ width: p.getBoundingClientRect().width, height: p.getBoundingClientRect().height, length: p.textContent.length })) }));
    assert.equal(geometry.overflow, false); assert.ok(geometry.width > (width === 390 ? 260 : 550)); assert.ok(geometry.paragraphs.every(p => p.width > 200));
    await page.screenshot({ path: path.join(out, `layout-${width}.png`), fullPage: true }); result.cases.push({ layout: width, geometry });
    await area.screenshot({ path: path.join(out, `bundle-${width}.png`) });
    await area.getByText("Unresolved records and source links (1)", { exact: true }).click();
  }
  // Real response bytes are held by this independent HTTP server, not fetch mocks.
  await button("Reopen this snapshot").click(); await expect(button("Save part 1")).toBeEnabled(); mode = "paced";
  await button("Save part 1").click(); await waitBytes(); const count = downloads.length;
  await button("Cancel part 1").click(); await expect(button("Retry part 1")).toBeEnabled(); assert.equal(downloads.length, count); hold?.(); mode = "valid";
  await checkDownload(await getDownload(() => button("Retry part 1").click()), "zip", 1);
  assert.equal(result.requests.at(-1).range, `bytes=4096-${zips[0].length - 1}`); result.cases.push("cancel retains4096 bytes; exact Range+If-Match resume and full SHA256/device bytes");
  await button("Reopen this snapshot").click(); await expect(button("Save part 1")).toBeEnabled(); mode = "interrupt";
  await button("Save part 1").click(); await waitBytes(); hold(); await expect(button("Retry part 1")).toBeEnabled(); mode = "valid";
  await checkDownload(await getDownload(() => button("Retry part 1").click()), "zip", 1); result.cases.push("actual body interruption pauses; explicit ranged retry reconstructs exact ZIP");
  for (const failure of ["etag", "hash", "409", "410", "412", "416", "429", "503"]) {
    await button("Reopen this snapshot").click(); await expect(button("Save part 1")).toBeEnabled(); mode = failure; const count = downloads.length;
    await button("Save part 1").click(); await expect(area.getByRole("alert")).toBeVisible(); await expect(button("Download selected parts")).toBeEnabled();
    assert.equal(downloads.length, count); mode = "valid"; result.cases.push(`${failure} rejection: no device file, deliberate recovery available`);
  }
  // An invalid resumed Content-Range must discard the partial, never splice it.
  await button("Reopen this snapshot").click(); await expect(button("Save part 1")).toBeEnabled(); mode = "paced";
  await button("Save part 1").click(); await waitBytes(); await button("Cancel part 1").click(); hold?.(); mode = "range";
  const rangeCount = downloads.length; await button("Retry part 1").click(); await expect(area.getByRole("alert")).toContainText("integrity");
  assert.equal(downloads.length, rangeCount); mode = "valid";
  await checkDownload(await getDownload(() => button("Retry part 1").click()), "zip", 1); assert.equal(result.requests.at(-1).range, null);
  result.cases.push("bad resumed Content-Range discarded partial; explicit retry restarted zero with exact verified device bytes");
  for (const status of [200, 401, 503]) for (const order of ["pending", "published"]) {
    mode = `held${status}`; await page.getByLabel("Saved download snapshots", { exact: true }).selectOption(alt.snapshotID);
    await expect(area.getByRole("status").filter({ hasText: "Opening saved snapshot" })).toBeVisible();
    await expect.poll(() => typeof hold).toBe("function"); const oldRelease = hold;
    mode = order === "pending" ? "held200" : "valid";
    await page.getByLabel("Saved download snapshots", { exact: true }).selectOption(d.snapshotID);
    if (order === "published") await expect(button("Save bundle manifest")).toBeEnabled();
    else await expect.poll(() => hold !== oldRelease).toBe(true);
    const currentRelease = hold; oldRelease();
    if (order === "pending") { await expect(area.getByRole("status").filter({ hasText: "Opening saved snapshot" })).toBeVisible(); currentRelease(); }
    await expect(button("Save bundle manifest")).toBeEnabled(); await expect(page.getByLabel("Choose library", { exact: true })).toBeVisible();
    assert.equal(await area.getByRole("alert").count(), 0); result.cases.push(`obsolete manifest${status} release after newer ${order}: current scope retained`);
  }
  mode = "paced"; await button("Save part 1").click(); await waitBytes(); const prior = downloads.length;
  await page.getByLabel("Choose library", { exact: true }).selectOption("L2"); hold?.(); mode = "valid";
  await expect(area).toHaveCount(0); assert.equal(downloads.length, prior);
  enabled = true;
  await page.getByLabel("Choose library", { exact: true }).selectOption("L1"); await openPlan(); await openSnapshot(d.snapshotID);
  mode = "paced"; await button("Save part 1").click(); await waitBytes(); const beforeLogout = downloads.length;
  await button("Sign out").click(); await login("B"); await openPlan(); await openSnapshot(unavailable.snapshotID);
  hold?.(); mode = "valid"; assert.equal(downloads.length, beforeLogout);
  await expect(area.getByText("No originals are available in this snapshot.", { exact: false })).toBeVisible();
  await expect(button("Download selected parts")).toHaveCount(0);
  await checkDownload(await getDownload(() => button("Save bundle manifest").click()), "json"); result.cases.push("library retirement blocks late part; new account usable; manifest-only snapshot remains downloadable");
  enabled = false; await page.reload(); await expect(page.getByLabel("Choose library", { exact: true })).toBeVisible();
  await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").first().click(); await expect(button("Select all saved")).toBeEnabled(); await showWorkspace(page, "Research plans"); await page.getByLabel("Saved plans", { exact: true }).selectOption(plan.planID);
  await expect(button("Prepare download parts")).toBeDisabled(); await openSnapshot(d.snapshotID);
  mode = "401"; await button("Save part 1").click(); await expect(button("Sign in")).toBeEnabled(); await expect(area).toHaveCount(0);
  mode = "valid"; await login("A"); result.cases.push("policy-disabled new preparation retains saved reads; current401 clears private UI and login remains usable");
  assert.deepEqual(errors, []); assert.deepEqual(external, []); result.after = { source: hashes("src"), dist: hashes("dist") }; assert.deepEqual(result.after, before);
  result.prepareBodies = prepareBodies; result.outcome = "passed";
} catch (error) { result.outcome = "failed"; result.error = String(error.stack ?? error); if (page) { await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {}); result.pageText = await page.locator("body").innerText().catch(() => "unavailable"); } throw error; }
finally { result.output = out; fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ outcome: result.outcome, output: out, cases: result.cases.length, downloads: result.downloads.length })); hold?.(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
