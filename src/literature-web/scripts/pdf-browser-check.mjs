// Synthetic transport/bytes only. No native handler, real-source or product PDF qualification.
import assert from "node:assert/strict";
import { installBodyGates } from "./body-gates.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preview } from "vite";
import { chromium } from "@playwright/test";
import { zipSync, unzipSync } from "../../../tests/native-browser/node_modules/fflate/esm/index.mjs";

const root = process.cwd(), out = path.join(root, ".litradock/runtime/frontend012", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hashes = () => Object.fromEntries(fs.readdirSync(path.join(root, "dist"), { recursive: true }).filter(file => fs.statSync(path.join(root, "dist", file)).isFile()).sort().map(file => [file, digest(fs.readFileSync(path.join(root, "dist", file)))]));
const before = hashes(), result = { scope: "SYNTHETIC compiled browser and synthetic PDF/ZIP bytes; NOT native/provider evidence", dist: before, checks: [], downloads: [] };
function syntheticPdf() {
  const stream = "BT /F1 14 Tf 30 80 Td (SYNTHETIC TEST ONLY - not an article) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const pdf = syntheticPdf(), xml = Buffer.from("<synthetic>XML preservation control</synthetic>"), hash = digest(pdf);
const manifest = Buffer.from(JSON.stringify({ synthetic: true, items: [{ id: "S0", file: "S0.pdf" }, { id: "S1", file: "S1.pdf" }, { id: "S2", state: "held", reason: "SYNTHETIC no permitted PDF" }] }));
const zip = Buffer.from(zipSync({ "S0.pdf": pdf, "S1.pdf": pdf, "manifest.json": manifest }, { level: 0 }));
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(15000);
  const errors = [], downloads = [], posts = [], gets = [];
  page.on("pageerror", e => errors.push(String(e))); page.on("download", d => downloads.push(d));
  await page.addInitScript(installBodyGates, { mode: "pdf" });
  let authenticated = false, pdfEnabled = true, lost = true, batchReads = 0;
  const article = i => ({ SearchId: `S${i}`, Title: `SYNTHETIC long α 中文 record ${i}`, Pmid: `99000${i}`, OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/99000${i}/` });
  const run = n => ({ run_id: `R${n}`, input: `SYNTHETIC ${n} saved records; complex MeSH query`, total: 25001, fetched: n, state: "partial" });
  const plan = { planID: "PLN-00000000000000000000000000000001", runID: "R11", requestedFormat: "pdf", state: "complete", selectedCount: 11, createdAt: "2026-09-13", updatedAt: "2026-09-13", revision: 1, allowedActions: [], counts: { waiting: 0, queued: 0, running: 0, completed: 2, held: 9, retry: 0, paused: 0, cancelled: 0 }, admission: { admittedCount: 11, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 0 };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort();
    const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (url.pathname === "/service-info") return reply({ pdfEnabled, pdfPolicySummary: "SYNTHETIC permitted repository PDF only", planEnabled: true, acquisitionEnabled: true, searchEnabled: true });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (method === "POST") posts.push({ path: url.pathname, body: request.postDataJSON() }); else gets.push(url.pathname + url.search);
    if (url.pathname === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
    if (url.pathname === "/api/login") { authenticated = true; return reply({ csrf: "SYNTHETIC" }); }
    if (url.pathname === "/api/logout") { authenticated = false; return reply({}); }
    if (url.pathname === "/api/libraries") return reply({ items: [{ library_id: "L1", name: "SYNTHETIC A" }, { library_id: "L2", name: "SYNTHETIC B" }], total: 2 });
    if (/\/api\/libraries\/L[12]$/.test(url.pathname)) return reply({ runs: [0, 1, 10, 11, 100].map(run), batches: [{ batch_id: "XML1", state: "complete" }, { batch_id: "B1", state: "partial" }], totals: { runs: 5, batches: 2 }, offset: 0, limit: 100 });
    if (url.pathname.includes("/runs/")) {
      const n = Number(url.pathname.split("/R")[1]), offset = Number(url.searchParams.get("offset"));
      return reply({ run: run(n), records: Array.from({ length: Math.max(0, Math.min(5, n - offset)) }, (_, i) => article(offset + i)), total: n, offset, limit: 5 });
    }
    if (url.pathname.endsWith("/batches") && method === "POST") { if (lost) { lost = false; return route.abort("failed"); } return reply({ id: "B1" }); }
    if (url.pathname.endsWith("/plans") && method === "POST") return reply({ planID: "PLN-00000000000000000000000000000001", revision: 1, selectedCount: 11, state: "active", affectedCount: 0 });
    if (url.pathname.endsWith("/plans")) return reply({ plans: [plan], total: 1, offset: 0, limit: 25 });
    if (url.pathname.includes("/plans/PLN-00000000000000000000000000000001")) return reply({ plan, items: Array.from({ length: 11 }, (_, i) => ({ searchID: `S${i}`, rank: i + 1, childBatchID: "B1", phase: i < 2 ? "completed" : "held", acquisitionState: i < 2 ? "acquired" : "unavailable", reason: "SYNTHETIC rights decision", attempts: 1, retryEligible: false, downloadAvailable: i < 2, article: article(i), format: i < 2 ? "PDF" : "", mediaType: i < 2 ? "application/pdf" : "", original_hash: i < 2 ? hash : "", bytes: i < 2 ? pdf.length : 0 })), total: 11, offset: 0, limit: 25, nextPollAfterMs: 2000, policy: "SYNTHETIC" });
    if (url.pathname.includes("/batches/")) {
      const isXml = url.pathname.endsWith("XML1"), running = !isXml && ++batchReads === 1;
      return reply({ requestedFormat: isXml ? "xml" : "pdf", batch: { batch_id: isXml ? "XML1" : "B1", state: running ? "running" : "partial", created_at: "2026-09-13" }, items: Array.from({ length: isXml ? 1 : 3 }, (_, i) => ({ search_id: `S${i}`, rank: i + 1, state: running ? "queued" : i < 2 ? "acquired" : "unavailable", reason: i < 2 ? "" : "SYNTHETIC no permitted PDF; source links remain", attempts: 1, article: article(i), downloadAvailable: !running && i < 2, original_hash: isXml ? digest(xml) : hash, format: running || i === 2 ? "" : isXml ? "XML" : "PDF", mediaType: running || i === 2 ? "" : isXml ? "application/xml" : "application/pdf", version: "SYNTHETIC deposit 1", depositVersion: isXml ? "" : "1", depositType: "published article", bytes: isXml ? xml.length : pdf.length })), total: isXml ? 1 : 3, counts: running ? { queued: 3 } : { acquired: 2, unavailable: 1 } });
    }
    if (url.pathname.includes("/originals/")) {
      const isXml = url.pathname.endsWith(digest(xml));
      return route.fulfill({ status: 200, contentType: isXml ? "application/xml" : "application/pdf", body: isXml ? xml : pdf });
    }
    if (url.pathname.endsWith("/exports")) return route.fulfill({ status: 200, contentType: "application/zip", body: zip });
    return reply({ error: "Synthetic route missing" }, 404);
  });
  const open = async n => {
    await page.locator('.history-entry').filter({ has: page.locator('.history-id', { hasText: new RegExp(`R${n}$`) }) }).click();
    await page.getByRole("button", { name: "Select all", exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === "Select all").disabled);
  };
  await page.goto(origin); await page.getByLabel("Login", { exact: true }).fill("SYNTHETIC"); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (const n of [0, 1, 10, 11, 100]) { await open(n); assert((await page.locator('.selection-toolbar').innerText()).includes(`${n} selected of ${n} retrieved`)); }
  assert.equal(posts.filter(p => /\/(batches|plans)$/.test(p.path)).length, 0);
  await open(10);
  await page.locator('.result-card input').first().uncheck();
  await page.getByRole("button", { name: "Next records", exact: true }).click();
  assert((await page.locator('.selection-toolbar').innerText()).includes("9 selected of 10"));
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  await page.getByRole("button", { name: "Previous records", exact: true }).click();
  assert((await page.locator('.selection-toolbar').innerText()).includes("0 selected of 10"));
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  for (let i = 0; i < 3; i++) await page.locator('.result-card input').nth(i).check();
  await page.getByRole("button", { name: "Download PDFs (3 selected)", exact: true }).click();
  await page.getByRole("button", { name: "Retry same PDF request (3)", exact: true }).click();
  await page.getByRole("button", { name: "Save PDF", exact: true }).last().waitFor();
  const admissions = posts.filter(p => p.path.endsWith("/batches")); assert.equal(admissions.length, 2); assert.deepEqual(admissions[0].body, admissions[1].body); assert.equal(admissions[0].body.format, "pdf");
  assert((await page.locator('.batch-item').last().innerText()).includes("no permitted PDF")); assert.equal(await page.locator('.batch-item').last().getByRole("button", { name: "Save PDF", exact: true }).count(), 0);
  for (let i = 0; i < 2; i++) {
    const event = page.waitForEvent("download"); await page.getByRole("button", { name: "Save PDF", exact: true }).nth(i).click(); const download = await event;
    const bytes = fs.readFileSync(await download.path()); assert.deepEqual(bytes, pdf); assert.equal(download.suggestedFilename(), `S${i}.pdf`);
    result.downloads.push({ name: download.suggestedFilename(), bytes: bytes.length, sha256: digest(bytes) });
  }
  const zipEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Save PDF ZIP", exact: true }).click(); const zipDownload = await zipEvent;
  const zipBytes = fs.readFileSync(await zipDownload.path()); assert.deepEqual(zipBytes, zip); assert.equal(zipDownload.suggestedFilename(), "batch-B1.zip");
  const members = unzipSync(zipBytes); assert.deepEqual(Object.keys(members).sort(), ["S0.pdf", "S1.pdf", "manifest.json"]); assert.deepEqual(Buffer.from(members["S0.pdf"]), pdf); assert.deepEqual(Buffer.from(members["manifest.json"]), manifest);
  result.downloads.push({ name: zipDownload.suggestedFilename(), bytes: zipBytes.length, sha256: digest(zipBytes) });
  assert(gets.includes(`/api/libraries/L1/originals/S0/${hash}`));
  assert(gets.includes(`/api/libraries/L1/originals/S1/${hash}`));
  assert.deepEqual(posts.find(p => p.path.endsWith("/exports")).body, { batchID: "B1", format: "zip" });
  await page.locator('.batch-panel').screenshot({ path: path.join(out, "mixed-pdf-held-batch.png") });
  await open(11); await page.getByRole("button", { name: "Download PDFs (11 selected)", exact: true }).click(); await page.getByRole("heading", { name: "Plan PLN-00000000000000000000000000000001", exact: true }).waitFor();
  assert.equal(posts.filter(p => p.path.endsWith("/plans")).length, 1); assert.equal(posts.find(p => p.path.endsWith("/plans")).body.format, "pdf");
  await page.getByRole("button", { name: "Open child batch B1", exact: true }).first().click();
  await page.evaluate(() => { window.__holdOriginal = true; });
  await page.getByRole("button", { name: "Save PDF", exact: true }).first().click(); await page.waitForFunction(() => window.__bodyStarted);
  const countBefore = downloads.length;
  await page.getByLabel("Choose library", { exact: true }).selectOption("L2"); await page.evaluate(() => window.__releaseBody());
  await open(1); assert.equal(downloads.length, countBefore);
  await page.evaluate(() => { window.__holdOriginal = false; });
  await page.getByLabel("Saved batches", { exact: true }).selectOption("XML1");
  const xmlEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Save XML", exact: true }).click(); const xmlDownload = await xmlEvent; assert.deepEqual(fs.readFileSync(await xmlDownload.path()), xml); assert.equal(xmlDownload.suggestedFilename(), "S0.xml");
  for (const width of [1280, 390]) { await page.setViewportSize({ width, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.locator('.selection-toolbar').screenshot({ path: path.join(out, `selection-${width}.png`) }); }
  pdfEnabled = false; await page.reload(); await open(1); assert(await page.getByRole("button", { name: "Download PDFs (1 selected)", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.getByLabel("Login", { exact: true }).waitFor(); assert.equal(await page.locator('.batch-item,.plan-item').count(), 0);
  await page.getByLabel("Login", { exact: true }).fill("SYNTHETIC-B"); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC-B"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await open(1); assert((await page.locator('.selection-toolbar').innerText()).includes("1 selected of 1 retrieved"));
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
  result.checks = ["0/1/10/11/100 default-all complete saved set, no provider selection or auto acquisition", "Manual subset and Deselect all persist across pagination", "One batch or plan format-bound POST, lost-response exact replay", "Mixed acquired PDF/held, two exact PDF downloads and valid synthetic ZIP members", "Held old-library PDF body produces no download; XML remains XML", "Policy disabled; readable desktop/narrow selection; logout clears data"];
  result.pass = true;
} catch (error) { result.pass = false; result.error = String(error); process.exitCode = 1; }
finally { if (browser) await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); result.serverClosed = true; fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, receipt: out }, null, 2)); }
