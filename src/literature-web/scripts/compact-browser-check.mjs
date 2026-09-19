// Closed-transport behavioral controls. All metadata here is explicitly synthetic.
// This never acquires papers, calls NCBI or represents a live PubMed comparison.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preview } from "vite";
import { chromium, expect } from "@playwright/test";

const root = process.cwd(), out = path.join(root, ".litradock/runtime/native022", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const result = { scope: "SYNTHETIC compiled frontend; closed transport; zero external/provider requests", assets: Object.fromEntries(fs.readdirSync('dist/assets').map(name => [name, hash(`dist/assets/${name}`)])), checks: [], geometry: [] };
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const runID = n => `RUN-${String(n).padStart(32, "0")}`;
const article = n => ({ SearchId: `SYNTHETIC-${n}`, Title: `SYNTHETIC record ${n}: α 中文 preserved bibliography`, Authors: "Synthetic Author", Year: "2024", Journal: "Synthetic Journal", Doi: `10.0000/synthetic-${n}`, Pmid: String(99000000 + n), Pmcid: `PMC${99000000 + n}`, OriginalUri: `https://pubmed.ncbi.nlm.nih.gov/${99000000 + n}/`, Abstract: "SYNTHETIC abstract.\n".repeat(70) });
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  result.browser = browser.version();
  for (const viewport of [{ width: 1365, height: 833 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(12000);
    const errors = [], posts = [], requests = [];
    let authenticated = false, nextRun = 2, batchIDs = [], pdfPending = false, pdfFailure = false, heldSearch = null, rejectSearch = false;
    const runs = new Map([[runID(1), { run_id: runID(1), input: "SYNTHETIC asthma OR COPD", total: 243, fetched: 10, state: "partial" }]]);
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, "External request forbidden");
      const endpoint = url.pathname;
      requests.push({ endpoint, method: request.method() });
      const reply = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (endpoint === "/service-info") return reply({ searchEnabled: true, searchContinuationEnabled: true, planEnabled: true, pdfEnabled: true, acquisitionEnabled: true, savedSetEnabled: true });
      if (!endpoint.startsWith("/api/")) return route.continue();
      if (request.method() === "POST") posts.push({ endpoint, body: request.postDataJSON() });
      if (endpoint === "/api/session") return reply(authenticated ? { csrf: "SYNTHETIC" } : {}, authenticated ? 200 : 401);
      if (endpoint === "/api/login") { authenticated = true; return reply({ csrf: "SYNTHETIC" }); }
      if (endpoint === "/api/logout") { authenticated = false; return reply({}); }
      if (endpoint === "/api/libraries") return reply({ items: [{ library_id: "L1", name: "Synthetic library one" }, { library_id: "L2", name: "Synthetic library two" }], total: 2 });
      const library = endpoint.split("/")[3];
      if (/^\/api\/libraries\/L[12]$/.test(endpoint)) return reply({ runs: library === "L1" ? [...runs.values()] : [], batches: [], totals: { runs: library === "L1" ? runs.size : 0, batches: 0 }, offset: 0, limit: 100 });
      if (endpoint.endsWith("/plans")) return reply({ plans: [], total: 0, offset: 0, limit: 25 });
      if (endpoint.endsWith("/search")) {
        const id = runID(nextRun++), body = request.postDataJSON();
        if (heldSearch) await heldSearch;
        if (rejectSearch) return reply({ error: "SYNTHETIC rejected search" }, 400);
        runs.set(id, { run_id: id, input: body.query, total: 57, fetched: 10, state: "partial" });
        return reply({ id });
      }
      if (endpoint.includes("/runs/")) {
        const run = runs.get(endpoint.split("/")[5]), offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 25);
        if (library !== "L1" || !run) return reply({ error: "SYNTHETIC library boundary" }, 404);
        return reply({ run, records: Array.from({ length: run.fetched }, (_, n) => article(n)).slice(offset, offset + limit), total: run.fetched, offset, limit });
      }
      if (endpoint.endsWith("/batches")) {
        batchIDs = request.postDataJSON().searchIDs;
        return reply({ id: "SYNTHETIC-BATCH" });
      }
      if (endpoint.includes("/batches/")) {
        if (pdfFailure) return reply({ error: "SYNTHETIC local file-status failure" }, 503);
        return reply({ batch: { batch_id: "SYNTHETIC-BATCH", state: pdfPending ? "running" : "partial", created_at: "2026-09-19" }, requestedFormat: "pdf", total: batchIDs.length,
          counts: pdfPending ? { queued: batchIDs.length } : { unavailable: batchIDs.length }, items: batchIDs.map((id, rank) => ({ search_id: id, rank, state: pdfPending ? "queued" : "unavailable", attempts: 1, reason: "SYNTHETIC local no-file outcome; no provider request.", article: article(Number(id.split('-')[1])), downloadAvailable: false, format: "PDF" })) });
      }
      return reply({ error: "SYNTHETIC unsupported route" }, 404);
    });
    const button = name => page.getByRole("button", { name, exact: true });
    const nav = async name => { await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name, exact: true }).click(); };
    const open = async id => { await nav("Saved searches"); await page.locator('.history-entry').filter({ has: page.locator('.history-id', { hasText: id }) }).click(); await expect(button("Select all")).toBeEnabled(); };
    const filters = async () => { if (!await page.locator('.search-filters').evaluate(e => e.open)) await page.locator('.search-filters > summary').click(); };
    const selection = page.getByRole("region", { name: "Saved record selection" });
    const measure = async name => {
      await page.evaluate(() => scrollTo(0, 0));
      const geometry = await page.evaluate(() => {
        const box = selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect(); return { y: r.y, bottom: r.bottom, width: r.width }; };
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, query: box('#pubmed-query'), results: box('#results-heading'), selection: box('.selection-toolbar'), pdf: box('.pdf-availability > button'), ...(document.querySelector('.result-card h3') ? { firstTitle: box('.result-card h3') } : {}) };
      });
      assert(geometry.documentWidth <= viewport.width, `${name}: horizontal overflow`);
      for (const key of ['query', 'results', 'selection', 'pdf']) assert(geometry[key].y >= 0 && geometry[key].bottom < viewport.height, `${name}: essential ${key} is below viewport: ${JSON.stringify(geometry[key])}`);
      if (geometry.firstTitle) assert(geometry.firstTitle.y < viewport.height - 20, `${name}: first result title is not discoverable in the initial view`);
      result.geometry.push({ name, ...geometry });
      await page.screenshot({ path: path.join(out, `${viewport.width}-${name}.png`) });
    };
    await page.goto(origin);
    await page.getByLabel("Login", { exact: true }).fill("SYNTHETIC"); await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC"); await button("Sign in").click();
    await expect(page.getByLabel("Choose library")).toHaveValue("L1");
    await measure("initial");
    await open(runID(1)); await measure("saved-run");
    await page.getByLabel("Page size", { exact: true }).selectOption("5");
    await expect(page.locator('.result-card')).toHaveCount(5);
    await page.locator('.result-card input').first().uncheck(); await button("Next records").click();
    await expect(selection).toContainText("9 selected of 10 loaded");
    await button("Deselect all").focus(); await page.keyboard.press("Enter"); await button("Previous records").click();
    await expect(selection).toContainText("0 selected of 10 loaded");
    await button("Select all").click();
    const query = '"heart failure"[Title] OR asthma';
    await page.getByLabel("Search PubMed", { exact: true }).fill(query);
    await expect(button("Download PDFs (10 selected)")).toBeDisabled();
    await filters(); await page.getByLabel("Publication year from").fill("2020"); await page.getByLabel("Publication year to").fill("2024");
    await page.getByRole("checkbox", { name: "Review", exact: true }).check(); await page.getByLabel("Text availability", { exact: true }).selectOption("free");
    await button("Apply filters").focus(); await page.keyboard.press("Enter");
    const expectedQuery = `(${query}) AND (2020:2024[dp]) AND ("Review"[pt]) AND (free full text[sb])`;
    await expect(page.locator('.filter-state')).toHaveText("Filters applied");
    assert.equal(posts.filter(p => p.endpoint.endsWith('/search')).at(-1).body.query, expectedQuery);
    await measure("filtered-run");
    await page.reload(); await expect(selection).toContainText("10 selected of 10 loaded");
    await expect(page.getByLabel("Search PubMed", { exact: true })).toHaveValue(query);
    await expect(page.locator('.filter-state')).toHaveText("Filters applied");
    await filters(); await expect(page.getByRole("checkbox", { name: "Review", exact: true })).toBeChecked();
    await expect(page.getByLabel("Publication year from")).toHaveValue("2020");
    await button("Remove Review filter").click(); await expect(button("Download PDFs (10 selected)")).toBeDisabled();
    await button("Clear filters").click(); await expect(page.locator('.filter-chips button')).toHaveCount(0);
    await button("Restore active search").click(); await expect(page.locator('.filter-state')).toHaveText("Filters applied");
    if (viewport.width < 900) await page.locator('.search-filters > summary').click();
    await nav("Research plans"); await page.goBack(); await expect(page.locator('.active-results')).toBeVisible();
    await expect(selection).toContainText("10 selected of 10 loaded");
    // Same mounted PDF request survives secondary views, local failure and retry.
    await button("Deselect all").click(); await page.locator('.result-card input').first().check();
    pdfPending = true; await button("Download PDFs (1 selected)").click();
    await expect(page.locator('.pdf-progress')).toContainText('1 pending');
    await nav("Saved searches"); await expect(page.locator('.pdf-view-notice')).toContainText('1 pending'); await button("Return to PDF progress").click();
    await expect(page.locator('.pdf-progress')).toContainText('1 pending');
    await button("Stop waiting").click(); pdfPending = false; pdfFailure = true;
    await button("Continue checking").click(); await expect(page.locator('.pdf-progress [role=alert]')).toBeVisible();
    pdfFailure = false; await button("Continue checking").click(); await expect(page.locator('.pdf-progress')).toContainText('No PDF is available');
    assert.equal(posts.filter(p => p.endpoint.endsWith('/batches')).length, 1, 'view changes and retries must not admit another batch');
    await expect(page.locator('.pdf-results')).toContainText('SYNTHETIC local no-file');
    await expect(page.locator('.pdf-results').getByRole('link', { name: 'Open PubMed' })).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/99000000/');
    await page.screenshot({ path: path.join(out, `${viewport.width}-local-no-file.png`) });
    await page.getByLabel("Choose library").selectOption("L2");
    await expect(page.getByLabel("Search PubMed", { exact: true })).toHaveValue('');
    await expect(page.locator('.pdf-progress')).toHaveText('');
    await expect(selection).toContainText('0 selected of 0 loaded');
    await page.goBack(); await expect(page.getByLabel('Choose library')).toHaveValue('L1');
    await expect(page.getByLabel("Search PubMed", { exact: true })).toHaveValue(query);
    await expect(page.locator('.pdf-progress')).toHaveText('');
    assert.equal(posts.filter(p => p.endpoint.endsWith('/search')).length, 1, 'reopen/reload/back must only read saved searches');
    // Every focus target remains visible with no fixed/sticky overlay masking it.
    await page.getByLabel('Search PubMed', { exact: true }).focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => { const e = document.activeElement, r = e.getBoundingClientRect(); const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)); const top = document.elementFromPoint(x, y); return { visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight, uncovered: e.contains(top) || top?.contains(e) }; });
      assert(focused.visible && focused.uncovered, 'keyboard focus hidden or covered');
    }
    // Late results cannot replace a newer unsent draft. Pending and rejected
    // search status must remain discoverable while a secondary view is open.
    let releaseSearch;
    heldSearch = new Promise(resolve => { releaseSearch = resolve; });
    await page.getByLabel('Search PubMed', { exact: true }).fill('SYNTHETIC submitted search');
    await button('Search PubMed').click();
    await expect.poll(() => posts.filter(p => p.endpoint.endsWith('/search')).length).toBe(2);
    await page.getByLabel('Search PubMed', { exact: true }).fill('SYNTHETIC later unsent draft');
    await nav('Saved searches'); await expect(page.locator('.search-view-notice')).toContainText('pending');
    releaseSearch(); heldSearch = null;
    await expect(page.locator('.search-view-notice')).toHaveCount(0);
    await nav('Search & PDFs');
    await expect(page.getByLabel('Search PubMed', { exact: true })).toHaveValue('SYNTHETIC later unsent draft');
    await expect(page.locator('.draft-notice')).toBeVisible();
    await expect(button('Download PDFs (10 selected)')).toBeDisabled();
    rejectSearch = true;
    await button('Search PubMed').click(); await nav('Saved searches');
    await expect(page.locator('.search-view-notice[role=alert]')).toContainText('not admitted');
    assert.equal(posts.filter(p => p.endpoint.endsWith('/search')).length, 3);
    await button('Sign out').click(); await expect(page.getByLabel('Login', { exact: true })).toBeVisible();
    assert.equal(await page.locator('.result-card,.history-entry,.pdf-results').count(), 0);
    assert.deepEqual(errors, []);
    result.checks.push({ viewport, passed: ['initial/saved/filtered geometry and first title', 'cross-page deselection', 'keyboard filter composition', 'reload and back restore', 'draft/apply distinction', 'view-stable PDF intent', 'pending/failure/zero-file retry', 'library isolation', 'keyboard focus', 'pending result preserves edited draft', 'search pending/error visible across views', 'logout'], searchPosts: 3, pdfPosts: 1, requests: requests.length });
    await page.close();
  }
  result.pass = true;
} catch (error) { result.pass = false; result.error = String(error); result.stack = error.stack; process.exitCode = 1; }
finally { if (browser) await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ out, ...result }, null, 2)); }
