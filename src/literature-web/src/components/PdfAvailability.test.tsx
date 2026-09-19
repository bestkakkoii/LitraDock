// @vitest-environment jsdom
// Closed synthetic transport; no source/provider or live acceptance claim.
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PdfAvailability } from './PdfAvailability';
import { setSession, clearSession, sessionGeneration } from '../api';
import { handoffPdf } from '../pdfDownload';
vi.mock('../pdfDownload', async importOriginal => ({ ...await importOriginal<object>(), handoffPdf: vi.fn() }));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
let host: HTMLDivElement, root: Root, scope: AbortController;
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
const render = (ids = ['S1']) => root.render(<PdfAvailability selectedCount={ids.length} ids={ids} ready enabled plansEnabled library='L1' runID='R1' generation={sessionGeneration()} scopeSignal={scope.signal}/>);
const held = { requestedFormat: 'pdf', batch: { batch_id: 'B1', state: 'partial' }, items: [{ search_id: 'S1', state: 'unavailable', article: { SearchId: 'S1', Title: 'SYNTHETIC held', OriginalUri: 'https://pubmed.ncbi.nlm.nih.gov/990000001/' }, downloadAvailable: false, reason: 'No permitted deposit' }], total: 1 };
beforeEach(async () => { vi.stubGlobal('Blob', (await vi.importActual<{ Blob: typeof Blob }>('node:buffer')).Blob); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; setSession({ csrf: 'SYNTHETIC' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); scope = new AbortController(); vi.mocked(handoffPdf).mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); clearSession(); });
it.each([404, 409, 503])('confirmed admission with HTTP %i detail failure keeps GET-only recovery', async status => {
  let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { if (init.method === 'POST') { posts++; return json({ id: 'B1' }); } return json({ error: 'SYNTHETIC detail failed' }, status); }));
  await act(async () => render()); await act(async () => button('Download PDFs (1 selected)').click());
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => button('Continue checking').click());
  expect(posts).toBe(1); expect(handoffPdf).not.toHaveBeenCalled();
});
it('a confirmed plan retains its receipt on failed GET and reads all selected members', async () => {
  let posts = 0; const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { posts++; return json({ planID: 'PLN-00000000000000000000000000000001', revision: 1, selectedCount: 11, affectedCount: 0, state: 'active' }); }
    reads.push(url); return json({ error: 'SYNTHETIC unavailable' }, 503);
  }));
  await act(async () => render(Array.from({ length: 11 }, (_, i) => `S${i}`)));
  await act(async () => button('Download PDFs (11 selected)').click());
  await act(async () => button('Continue checking').click());
  expect(posts).toBe(1); expect(reads).toHaveLength(2); expect(reads.every(path => path.endsWith('?offset=0&limit=100'))).toBe(true);
});
it('lost admission reuses the immutable request even after a new selection; held results are local and linked', async () => {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'POST') { posts.push(String(init.body)); if (posts.length === 1) throw new Error('lost reply'); return json({ id: 'B1' }); }
    return json(held);
  }));
  await act(async () => render()); await act(async () => button('Download PDFs (1 selected)').click());
  await act(async () => render(['S2', 'S3'])); await act(async () => button('Retry same PDF request').click());
  expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1]);
  expect(host.textContent).toContain('No PDF is available for this selection');
  expect(host.querySelector('.pdf-results')?.hasAttribute('open')).toBe(true);
  expect(host.querySelector('a')?.href).toBe('https://pubmed.ncbi.nlm.nih.gov/990000001/');
  expect(button('Download current selection (2)')).toBeTruthy(); expect(handoffPdf).not.toHaveBeenCalled();
});
it('rapid double click, stop and late detail do not duplicate POST or hand off stale data', async () => {
  let posts = 0, release!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { if (init.method === 'POST') { posts++; return json({ id: 'B1' }); } return new Promise<Response>(resolve => { release = resolve; }); }));
  await act(async () => render());
  await act(async () => { const start = button('Download PDFs (1 selected)'); start.click(); start.click(); });
  expect(posts).toBe(1); expect(host.textContent).toContain('Preparing PDFs');
  await act(async () => button('Stop waiting').click());
  await act(async () => release(json(held)));
  expect(host.textContent).toContain('Checking stopped'); expect(handoffPdf).not.toHaveBeenCalled();
});
it('scope invalidation discards a late result and unmount/remount never resumes by itself', async () => {
  let release!: (value: Response) => void, calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls++; if (init.method === 'POST') return json({ id: 'B1' }); return new Promise<Response>(resolve => { release = resolve; }); }));
  await act(async () => render()); await act(async () => button('Download PDFs (1 selected)').click());
  await act(async () => scope.abort()); await act(async () => release(json(held)));
  expect(host.textContent).not.toContain('No permitted deposit'); expect(handoffPdf).not.toHaveBeenCalled();
  await act(async () => root.render(null)); scope = new AbortController(); await act(async () => render()); expect(calls).toBe(2);
});
it.each([2, 11])('%i previously ready records becoming unavailable update counts and never hand off a metadata-only PDF package', async count => {
  const ids = Array.from({ length: count }, (_, i) => `S${i}`), kind = count > 10 ? 'plan' : 'batch', id = kind === 'plan' ? 'PLN-00000000000000000000000000000001' : 'B1';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/exports')) {
      const report = { schema: 'litradock.pdf-download', schemaVersion: 1, kind, id, runID: 'R1', requestedFormat: 'pdf', selectedCount: count, includedRecords: 0, unresolvedRecords: count, archiveBytes: 0, archiveSha256: '',
        items: ids.map(searchId => ({ searchId, available: false, sourceOutcome: { status: 'restricted', requestedFormat: 'pdf', label: 'Stored original currently unavailable', detail: 'Current policy prevents this download.', nextAction: 'Open the article source links.', sourceLinks: {} } })) };
      const raw = new TextEncoder().encode(JSON.stringify(report)), prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, raw.length);
      return new Response(new Blob([prefix, raw]), { headers: { 'Content-Type': 'application/vnd.litradock.pdf-download' } });
    }
    if (init.method === 'POST') return json(kind === 'batch' ? { id } : { planID: id, revision: 1, selectedCount: count, affectedCount: 0, state: 'active' });
    const items = ids.map(searchID => ({ searchID, search_id: searchID, phase: 'completed', state: 'acquired', article: { SearchId: searchID, Title: `SYNTHETIC ${searchID}`, OriginalUri: 'https://pubmed.ncbi.nlm.nih.gov/990000001/' }, downloadAvailable: true, format: 'PDF', mediaType: 'application/pdf', original_hash: 'a'.repeat(64), bytes: 100 }));
    return json(kind === 'batch' ? { requestedFormat: 'pdf', batch: { batch_id: id, state: 'complete' }, total: count, items } : { plan: { planID: id, runID: 'R1', requestedFormat: 'pdf', state: 'complete', revision: 1, selectedCount: count, allowedActions: [], counts: { waiting: 0, queued: 0, running: 0, completed: count, held: 0, retry: 0, paused: 0, cancelled: 0 }, admission: {} }, total: count, items, offset: 0, limit: 100, nextPollAfterMs: 2000 });
  }));
  await act(async () => render(ids)); await act(async () => button(`Download PDFs (${count} selected)`).click());
  await vi.waitFor(async () => { await act(async () => {}); expect(host.textContent).toContain('No PDF remained available when the package was prepared'); });
  expect(host.textContent).toContain(`0 ready · 0 pending · ${count} without an available PDF`);
  expect(host.querySelector('.pdf-results')?.hasAttribute('open')).toBe(true);
  expect(host.textContent).toContain('Stored original currently unavailable');
  expect(host.querySelector('a')?.href).toBe('https://pubmed.ncbi.nlm.nih.gov/990000001/');
  expect(button('Export source outcomes')).toBeTruthy(); expect(button('Save again')).toBeUndefined(); expect(handoffPdf).not.toHaveBeenCalled();
});
