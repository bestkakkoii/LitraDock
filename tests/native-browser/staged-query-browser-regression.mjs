// Actual compiled native/React workflow with intercepted, labeled provider data.
// The browser cannot reach a genuine source or public demo from this workload.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { showWorkspace, openDisclosure } from '../../src/literature-web/scripts/workspace-navigation.mjs';
import { readNativeJson, setSavedCheckbox, selectionControl, selectionReady } from './selection-controls.mjs';

const inputPath = process.env.NATIVE_BROWSER_INPUT;
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const origin = new URL(process.env.NATIVE_BROWSER_URL);
assert.equal(origin.hostname, '127.0.0.1'); assert.equal(input.origin, origin.origin);
assert.equal(input.capture_seed.count, 20000);
const output = path.dirname(inputPath), checks = [], requests = [], forbidden = [], errors = [];
const browser = await chromium.launch({ headless: true });
const contexts = [];
const query = '("SYNTHETIC CAPTURE"[Title] OR fixture[MeSH Terms]) NOT review[pt] AND 2020:2026[dp]';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const ids = (start, count) => Array.from({ length: count }, (_, i) => String(start + i));
let holdRoot = true, releaseRoot = null, rootEntered = false;
const until = async (fn, message) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 700)); }
  throw Error(message);
};
async function context() {
  const c = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 850 } }); contexts.push(c);
  await c.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin.origin) return route.continue();
    if (url.origin !== 'https://eutils.ncbi.nlm.nih.gov' || !['/entrez/eutils/esearch.fcgi', '/entrez/eutils/efetch.fcgi'].includes(url.pathname)) {
      forbidden.push(url.origin); return route.abort();
    }
    assert.equal(request.method(), 'POST');
    const headers = await request.allHeaders();
    assert(!headers.cookie && !headers.authorization && !headers['x-csrf'] && !headers.referer);
    const params = new URLSearchParams(request.postData());
    assert.equal(params.get('db'), 'pubmed'); assert.equal(params.get('retmode'), 'xml'); assert(!params.has('api_key'));
    requests.push({ path: url.pathname, term: params.get('term'), ids: params.get('id'), retmax: params.get('retmax'), at: Date.now() });
    let xml;
    if (url.pathname.endsWith('esearch.fcgi')) {
      assert.equal(params.get('retstart'), '0'); assert.equal(params.get('sort'), 'relevance');
      const maximum = Number(params.get('retmax')), term = params.get('term');
      assert([1000, 9999].includes(maximum));
      assert(term === query || term.startsWith(`(${query}) AND (`) || term.startsWith(`(${query}) NOT (`), 'original query retained as an exact operand');
      let found = ids(930000001, maximum), total = 10001;
      if (maximum === 9999 && term !== query) {
        assert(term.includes('[crdt]'));
        if (term.startsWith(`(${query}) NOT (`)) { found = ['930010000', '930010001']; total = 2; }
        else total = 9999;
      }
      if (maximum === 9999 && term === query && holdRoot) {
        holdRoot = false; rootEntered = true;
        await new Promise(resolve => { releaseRoot = resolve; });
      }
      xml = `<eSearchResult><Count>${total}</Count><RetMax>${found.length}</RetMax><RetStart>0</RetStart><IdList>${found.map(id => `<Id>${id}</Id>`).join('')}</IdList><QueryTranslation>${xmlText(term)}</QueryTranslation></eSearchResult>`;
    } else {
      const requested = params.get('id').split(',');
      assert(requested.length >= 1 && requested.length <= 100); assert(requested.every(id => /^9300[0-9]{5}$/.test(id)));
      xml = '<PubmedArticleSet>' + requested.filter(id => id !== '930000002').map(id => `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><Journal><Title>SYNTHETIC Journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal><ArticleTitle>SYNTHETIC ONLY 中文 ${id}</ArticleTitle><Abstract><AbstractText>Isolated fixture, never a genuine result.</AbstractText></Abstract></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.0000/synthetic${id}</ArticleId><ArticleId IdType="pmc">PMC${id}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`).join('') + '</PubmedArticleSet>';
    }
    return route.fulfill({ status: 200, contentType: 'text/xml; charset=utf-8', body: xml, headers: { 'Access-Control-Allow-Origin': '*' } }).catch(() => {});
  });
  c.on('page', p => { p.setDefaultTimeout(90000); p.on('pageerror', error => errors.push(error.message)); });
  return c;
}
async function login(page, account) {
  await page.goto(origin.origin); await page.getByLabel('Login', { exact: true }).fill(account.login);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByLabel('Choose library', { exact: true }).waitFor();
}
const detail = (page, library, run) => readNativeJson(page, `${origin.origin}/api/libraries/${library}/runs/${run}?limit=100`);
const selection = (page, library, run) => readNativeJson(page, `${origin.origin}/api/libraries/${library}/runs/${run}/selection`);
const progress = page => page.getByRole('region', { name: 'Search continuation', exact: true });
async function check(name, fn) {
  console.log(JSON.stringify({ started: name })); await fn(); checks.push({ name, pass: true }); console.log(JSON.stringify({ passed: name }));
}
async function findMore(page, library, run, expectedCount) {
  const before = requests.length;
  const uploaded = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/user-route/upload'));
  await page.getByRole('button', { name: 'Find more results', exact: true }).click();
  assert.equal((await uploaded).status(), 200);
  // Test probes share the two application slots. Observe actual UI read-back
  // before an independent GET, so the probe does not displace that read-back.
  await until(async () => (await page.locator('.compact-result-head').innerText()).includes(`${expectedCount.toLocaleString('en-US')} IDs captured`), 'captured membership rendered');
  await selectionReady(page);
  const value = await detail(page, library, run);
  assert.equal(value.continuation.windowCount, expectedCount);
  assert(!['queued', 'running'].includes(value.continuation.state));
  await page.waitForTimeout(1600); assert.equal(requests.length, before + 1, 'capture never automatically advances');
}
async function download(page, name, filename) {
  const waiting = page.waitForEvent('download'); await page.getByRole('button', { name, exact: true }).click();
  const destination = path.join(output, filename); await (await waiting).saveAs(destination); return fs.readFileSync(destination);
}
async function openSaved(page, library, label) {
  await page.getByLabel('Choose library', { exact: true }).selectOption(library);
  await showWorkspace(page, 'Saved searches');
  await page.getByRole('list', { name: 'Saved searches', exact: true }).getByRole('button').filter({ hasText: label }).click();
  // Workspace sections remain mounted while hidden. Require the actual opened
  // research view, so a hidden stale card cannot satisfy narrow-reopen evidence.
  await until(async () => await page.getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Search & PDFs', exact: true }).getAttribute('aria-current') === 'page'
    && await page.locator('.result-card').first().isVisible(), 'saved results visibly reopened');
}
async function defaultViewport(page, name) {
  // Secondary disclosures grow legitimately; inspect the actual default view
  // without locator clicks or automatic scrolling concealing action placement.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 850 });
    // Observe the responsive filter state instead of sampling during its change.
    // The real desktop sidebar stays open; the narrow panel must close itself.
    await page.waitForFunction(wide => window.matchMedia('(min-width: 900px)').matches === wide
      && document.querySelector('.search-filters')?.open === wide, width >= 900, { timeout: 5000 });
    await page.evaluate(() => document.querySelectorAll('details').forEach(details => {
      if (details.classList.contains('search-filters')) return;
      const summary = details.querySelector(':scope > summary');
      if (summary && !summary.hidden) details.open = false;
    }));
    await page.evaluate(() => scrollTo(0, 0));
    const bounds = await page.evaluate(() => {
      const rect = element => {
        if (!element || !element.getClientRects().length) return null;
        const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const section = document.querySelector('.active-results');
      return { viewport: { width: innerWidth, height: innerHeight }, scrollY,
        filterOpen: document.querySelector('.search-filters').open,
        wide: window.matchMedia('(min-width: 900px)').matches,
        font: getComputedStyle(document.documentElement).fontFamily,
        header: rect(section.querySelector('.compact-result-head')),
        counts: rect(section.querySelector('.result-counts')),
        controls: rect(section.querySelector('.staged-actions')),
        selection: rect(section.querySelector('.selection-and-pdfs')),
        firstResult: rect(section.querySelector('.result-card')),
        firstTitle: rect(section.querySelector('.result-card h3')),
        capture: rect([...section.querySelectorAll('button')].find(b => b.textContent === 'Find more results')),
        metadata: rect([...section.querySelectorAll('button')].find(b => b.textContent === 'Download selected metadata ZIP')) };
    });
    await page.screenshot({ path: path.join(output, `staged-default-${name}-${width}.png`) });
    const afterScreenshot = await page.evaluate(() => ({ filterOpen: document.querySelector('.search-filters').open,
      titleBottom: document.querySelector('.active-results .result-card h3').getBoundingClientRect().bottom }));
    checks.push({ name: `default-${name}-${width}`, bounds, afterScreenshot });
    assert.equal(bounds.filterOpen, width >= 900); assert.equal(afterScreenshot.filterOpen, bounds.filterOpen);
    assert(Math.abs(afterScreenshot.titleBottom - bounds.firstTitle.bottom) < .5, 'measurement and screenshot show the same settled viewport');
    assert.equal(bounds.scrollY, 0); assert(bounds.firstTitle && bounds.firstTitle.bottom <= bounds.viewport.height, 'first result title visible in default viewport');
    if (name === 'large') assert(bounds.metadata && bounds.metadata.top >= 0 && bounds.metadata.bottom <= bounds.viewport.height, 'large metadata action visible without scrolling');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    checks.at(-1).pass = true;
  }
}
let page, library, run, excluded;
try {
  const c = await context(); page = await c.newPage(); await login(page, input.accounts[0]);
  await showWorkspace(page, 'Libraries'); await page.getByLabel('New library name', { exact: true }).fill('SYNTHETIC deliberate capture');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await until(async () => await page.getByLabel('Choose library', { exact: true }).locator('option').filter({ hasText: 'SYNTHETIC deliberate capture' }).count() === 1, 'new query library saved');
  await page.getByLabel('Choose library', { exact: true }).selectOption({ label: 'SYNTHETIC deliberate capture' });
  library = await page.getByLabel('Choose library', { exact: true }).inputValue(); assert(library);
  await check('initial-query-1000-identities-99-saved-and-exact-exclusion', async () => {
    const info = await readNativeJson(page, origin.origin + '/service-info'); assert.equal(info.stagedQueryEnabled, true); assert.equal(info.selectionRecordLimit, 20000);
    await showWorkspace(page, 'Search & PDFs'); await page.getByLabel('Search PubMed', { exact: true }).fill(query);
    await openDisclosure(page, 'Search options'); await page.getByLabel('Retrieved limit', { exact: true }).selectOption('100');
    const receipt = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/search'));
    await page.getByRole('button', { name: 'Search PubMed', exact: true }).click();
    const response = await receipt; assert.equal(response.status(), 200); run = (await response.json()).id;
    await until(async () => (await detail(page, library, run)).run.fetched === 99, 'first bounded metadata page saved');
    const saved = await detail(page, library, run); assert.equal(saved.run.input, query); assert.equal(saved.run.total, 10001);
    assert.equal(saved.continuation.windowCount, 1000); assert.equal(saved.continuation.missingCount, 1); assert.equal(requests.length, 2);
    const chosen = await selection(page, library, run); excluded = chosen.selectedIDs[0];
    await setSavedCheckbox(page, page.locator('.result-card input[type=checkbox]').first(), false);
    assert.equal((await selection(page, library, run)).selectedCount, 98);
  });
  await check('held-capture-cancel-and-late-source-response-preserve-saved-data', async () => {
    await page.getByRole('button', { name: 'Find more results', exact: true }).click(); await until(() => rootEntered, 'source capture held');
    await openDisclosure(page, /^Search progress and query details/); await progress(page).getByRole('button', { name: 'Stop browser request', exact: true }).click();
    await until(async () => (await detail(page, library, run)).continuation.state === 'cancelled', 'capture cancellation saved');
    releaseRoot(); await page.waitForTimeout(1500);
    const saved = await detail(page, library, run); assert.equal(saved.continuation.windowCount, 1000); assert.equal(saved.run.fetched, 99);
    assert(!(await selection(page, library, run)).selectedIDs.includes(excluded));
  });
  await check('lost-capture-upload-reply-reconciles-without-source-replay', async () => {
    let dropped = false;
    await page.route('**/user-route/upload', async route => {
      if (!dropped && JSON.parse(route.request().postData()).body) {
        dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200);
        return route.fulfill({ status: 503, body: 'SYNTHETIC lost saved receipt' });
      }
      return route.continue();
    });
    const before = requests.length;
    await page.getByRole('button', { name: 'Find more results', exact: true }).click();
    await progress(page).getByRole('button', { name: 'Retry saving results', exact: true }).click();
    await until(async () => !await progress(page).getByRole('button', { name: 'Retry saving results', exact: true }).count(), 'capture receipt reconciled');
    assert(dropped); assert.equal(requests.length, before + 1);
    const saved = await detail(page, library, run); assert.equal(saved.continuation.capture.pendingSegments, 2); assert.equal(saved.continuation.windowCount, 1000);
    await page.unroute('**/user-route/upload');
  });
  await check('beyond10000-complement-coverage-is-explicit-and-metadata-separate', async () => {
    await findMore(page, library, run, 9999); await findMore(page, library, run, 10001);
    let saved = await detail(page, library, run); assert.equal(saved.continuation.capture.state, 'complete'); assert.equal(saved.run.fetched, 99);
    assert.equal(saved.continuation.capture.latestProviderTotal, 10001); assert.equal((await selection(page, library, run)).selectedCount, 98);
    const before = requests.length;
    await progress(page).getByRole('button', { name: 'Retrieve next metadata page', exact: true }).click();
    await until(async () => (await page.getByRole('region', { name: 'Saved record selection', exact: true }).innerText()).includes('198 selected of 199 saved'), 'new metadata and exact selection rendered');
    await selectionReady(page);
    assert.equal((await detail(page, library, run)).run.fetched, 199);
    assert.equal(requests.length, before + 1);
    const chosen = await selection(page, library, run); assert.equal(chosen.selectedCount, 198); assert(!chosen.selectedIDs.includes(excluded));
    await page.screenshot({ path: path.join(output, 'staged-query-1280.png'), fullPage: true });
    await defaultViewport(page, 'capture');
  });
  await check('selected-archive-manifest-unresolved-link-and-no-source-export', async () => {
    const before = requests.length;
    await openDisclosure(page, 'Export saved results and other actions');
    const bytes = await download(page, 'Download selected metadata ZIP', 'staged-selected.csv.zip');
    const files = unzipSync(bytes), manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    assert.equal(manifest.scope, 'selected'); assert.equal(manifest.count, 198); assert.equal(manifest.remaining, 0); assert.equal(manifest.capturedIdentities.length, 198);
    assert(manifest.capturedIdentities.every(member => member.searchId !== excluded && member.metadataState === 'saved'));
    assert.equal(manifest.files.length, 1); assert.equal(hash(files[manifest.files[0].name]), manifest.files[0].sha256);
    await openDisclosure(page, 'Export options');
    await openDisclosure(page, 'Individual export parts and captured IDs');
    const identities = JSON.parse(await download(page, 'Download captured-ID manifest', 'staged-identities.json'));
    assert.equal(identities.count, 10001); assert.equal(identities.capturedIdentities.find(member => member.pmid === '930000002').metadataState, 'missing');
    assert.equal(identities.capturedIdentities.at(-1).metadataState, 'pending');
    assert.equal(identities.capturedIdentities.find(member => member.pmid === '930000002').pubmedUrl, 'https://pubmed.ncbi.nlm.nih.gov/930000002/');
    assert.equal(requests.length, before); checks.push({ name: 'selected ZIP bytes', bytes: bytes.length, sha256: hash(bytes), pass: true });
  });
  await check('explicit-none-policy-survives-next-stage-and-narrow-reopen', async () => {
    await selectionControl(page, 'Deselect all');
    await openDisclosure(page, /^Search progress and query details/);
    await progress(page).getByRole('button', { name: 'Retrieve next metadata page', exact: true }).click();
    await until(async () => (await detail(page, library, run)).run.fetched === 299, 'none-policy next metadata page saved');
    assert.equal((await selection(page, library, run)).selectedCount, 0);
    const before = requests.length; await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await openSaved(page, library, 'SYNTHETIC CAPTURE');
    assert.equal((await selection(page, library, run)).selectedCount, 0); assert.equal(requests.length, before);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await page.locator('.result-card').first().isVisible());
    await page.screenshot({ path: path.join(output, 'staged-query-390.png'), fullPage: true });
    await page.screenshot({ path: path.join(output, 'staged-query-390-viewport.png') });
  });
  await check('20000-saved-metadata-bounded-rendering-exact-selected-whole-ZIP', async () => {
    const seed = input.capture_seed; await openSaved(page, seed.library, 'SYNTHETIC LARGE CAPTURE FIXTURE');
    let chosen = await selection(page, seed.library, seed.run); assert.equal(chosen.selectedIDs.length, 20000); assert.equal(chosen.recordsComplete, false);
    assert(await page.locator('.result-card').count() <= 100);
    await defaultViewport(page, 'large');
    await selectionControl(page, 'Deselect page'); chosen = await selection(page, seed.library, seed.run);
    assert(chosen.selectedCount >= 19900 && chosen.selectedCount < 20000);
    await openDisclosure(page, 'Export options'); await page.getByLabel('Metadata export format', { exact: true }).selectOption('json');
    const before = requests.length, started = Date.now();
    const bytes = await download(page, 'Download selected metadata ZIP', 'staged-large-selected.json.zip');
    const files = unzipSync(bytes), manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    assert.equal(manifest.scopeCount, chosen.selectedCount); assert.equal(manifest.count, chosen.selectedCount); assert.equal(manifest.remaining, 0); assert.equal(manifest.files.length, 20);
    const exported = [];
    for (const file of manifest.files) {
      assert.equal(hash(files[file.name]), file.sha256); const part = JSON.parse(Buffer.from(files[file.name]).toString('utf8'));
      assert(part.count <= 1000); assert.equal(part.count, file.count); exported.push(...part.records.map(record => record.searchId));
    }
    assert.deepEqual(new Set(exported), new Set(chosen.selectedIDs)); assert.equal(exported.length, chosen.selectedCount);
    assert.equal(requests.length, before); assert(bytes.length < 64 * 1024 * 1024);
    checks.push({ name: '20000-seeded selection ZIP', elapsedMs: Date.now() - started, bytes: bytes.length, sha256: hash(bytes), saved: 20000, exported: exported.length, pass: true });
    await page.screenshot({ path: path.join(output, 'staged-query-large-390.png'), fullPage: true });
  });
  await check('foreign-account-export-refused-with-owned-positive-control', async () => {
    const other = await context(), otherPage = await other.newPage(); await login(otherPage, input.accounts[1]);
    const response = await otherPage.request.get(`${origin.origin}/api/libraries/${library}/runs/${run}/capture-export?format=manifest`);
    assert.equal(response.status(), 404);
  });
  assert.deepEqual(forbidden, []); assert.deepEqual(errors, []); assert(!fs.existsSync(inputPath + '.source-requests'));
  const result = { sourceRevision: input.source_revision, browser: browser.version(), scope: 'SYNTHETIC ONLY; actual Go/PostgreSQL/compiled React; seeded 20000 metadata is not provider capacity', serverSourceCalls: 0, requests, checks };
  fs.writeFileSync(path.join(output, 'staged-query-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ checks, requests, errors, forbidden, pages: await Promise.all(contexts.flatMap(c => c.pages()).map(async p => ({ url: p.url(), body: await p.locator('body').innerText().catch(() => '<unavailable>') }))) })); throw error;
} finally {
  releaseRoot?.(); await Promise.all(contexts.map(c => c.close())); await browser.close();
}
