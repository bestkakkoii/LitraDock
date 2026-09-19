import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearSession, sessionGeneration, setSession } from './api';
import { PdfRequest } from './pdfRequest';
import { pdfFile, readPdfStatus } from './pdfDownload';

const bytes = new TextEncoder().encode('%PDF-1.4\nSYNTHETIC integrity control\n%%EOF\n');
let hash = '';
const signal = () => new AbortController().signal;
const item = (id = 'S1') => ({ search_id: id, article: { SearchId: id }, state: 'acquired', downloadAvailable: true, format: 'PDF', mediaType: 'application/pdf', original_hash: hash, bytes: bytes.length });
const batch = (items = [item()]) => ({ requestedFormat: 'pdf', batch: { batch_id: 'B1', state: 'complete' }, items, total: items.length });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(async () => { setSession({ csrf: 'SYNTHETIC' }); hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); });
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });
async function intent(ids = ['S1']) {
  const value = new PdfRequest('L1', 'R1', ids, sessionGeneration(), true);
  await value.send(signal()); return value;
}
it('a single original uses the verified exact hash and bytes, without acquisition retry', async () => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    paths.push(url);
    return init.method === 'POST' ? json({ id: 'B1' }) : url.includes('/originals/') ? new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }) : json(batch());
  }));
  const request = await intent(), status = await readPdfStatus(request, signal());
  const file = await pdfFile(request, status, signal());
  expect(new Uint8Array(await file.blob!.arrayBuffer())).toEqual(bytes);
  expect(file.filename).toBe('litradock-S1.pdf');
  expect(paths).toEqual(['/api/libraries/L1/batches', '/api/libraries/L1/batches/B1', `/api/libraries/L1/originals/S1/${hash}`]);
});
it.each(['foreign member', 'duplicate', 'wrong format', 'wrong media', 'wrong batch', 'count', 'missing bytes'])('rejects %s before fetching any file', async fault => {
  const detail = batch();
  if (fault === 'foreign member') detail.items[0].search_id = 'FOREIGN';
  if (fault === 'duplicate') { detail.items.push(detail.items[0]); detail.total++; }
  if (fault === 'wrong format') detail.items[0].format = 'XML';
  if (fault === 'wrong media') detail.items[0].mediaType = 'text/html';
  if (fault === 'wrong batch') detail.batch.batch_id = 'FOREIGN';
  if (fault === 'count') detail.total++;
  if (fault === 'missing bytes') detail.items[0].bytes = 0;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => json(init.method === 'POST' ? { id: 'B1' } : detail));
  vi.stubGlobal('fetch', fetch);
  await expect(readPdfStatus(await intent(), signal())).rejects.toThrow('did not match');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(['corrupt bytes', 'wrong MIME', 'revoked', 'stale session'])('does not hand off %s', async fault => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return json({ id: 'B1' });
    if (!url.includes('/originals/')) return json(batch());
    if (fault === 'revoked') return new Response('{}', { status: 403 });
    if (fault === 'stale session') clearSession();
    return new Response(fault === 'corrupt bytes' ? new TextEncoder().encode('X'.repeat(bytes.length)) : bytes, { headers: { 'Content-Type': fault === 'wrong MIME' ? 'text/html' : 'application/pdf' } });
  }));
  const request = await intent(), status = await readPdfStatus(request, signal());
  await expect(pdfFile(request, status, signal())).rejects.toThrow();
});
it.each([11, 100])('%i selected plan members are read together and retain run identity', async count => {
  const ids = Array.from({ length: count }, (_, i) => `S${i}`), id = 'PLN-00000000000000000000000000000001';
  let wrongRun = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return json({ planID: id, revision: 1, selectedCount: count, affectedCount: 0, state: 'active' });
    expect(url).toContain('offset=0&limit=100');
    return json({ plan: { planID: id, runID: wrongRun ? 'FOREIGN' : 'R1', requestedFormat: 'pdf', state: 'complete', revision: 1, selectedCount: count, allowedActions: [], counts: { waiting: 0, queued: 0, running: 0, completed: 0, held: count, retry: 0, paused: 0, cancelled: 0 }, admission: {} }, items: ids.map(searchID => ({ searchID, phase: 'held', article: { SearchId: searchID }, downloadAvailable: false })), total: count, offset: 0, limit: 100, nextPollAfterMs: 2000 });
  });
  vi.stubGlobal('fetch', fetch);
  const request = await intent(ids), status = await readPdfStatus(request, signal());
  expect(status).toMatchObject({ ready: 0, pending: 0, unresolved: count });
  wrongRun = true; await expect(readPdfStatus(request, signal())).rejects.toThrow('did not match');
});
it('never downloads an empty or malformed ZIP as an available PDF bundle', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => url.endsWith('/exports') ? new Response('not zip', { headers: { 'Content-Type': 'application/zip' } }) : json(init.method === 'POST' ? { id: 'B1' } : batch([item('S1'), item('S2')]))));
  const request = await intent(['S1', 'S2']), status = await readPdfStatus(request, signal());
  await expect(pdfFile(request, status, signal())).rejects.toThrow('did not match');
  await expect(pdfFile(request, { ...status, ready: 0 }, signal())).rejects.toThrow('No original PDF');
});

async function packageResponse(kind: string, id: string, ids: string[], available: boolean, fault = '') {
  // Synthetic protocol bytes only; real ZIP membership is verified in native
  // serializer tests and the separate compiled browser positive control.
  let archive = available ? new Uint8Array([80, 75, 3, 4, 1, 2, 3]) : new Uint8Array();
  const archiveHash = available ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', archive)), b => b.toString(16).padStart(2, '0')).join('') : '';
  const report = { schema: 'litradock.pdf-download', schemaVersion: 1, kind, id, runID: 'R1', requestedFormat: 'pdf', selectedCount: ids.length,
    includedRecords: available ? ids.length : 0, unresolvedRecords: available ? 0 : ids.length, archiveBytes: archive.length, archiveSha256: archiveHash,
    items: ids.map(searchId => ({ searchId, available, ...(available ? { sha256: hash, bytes: bytes.length, file: kind === 'plan' ? `originals/${hash}.pdf` : `originals/${searchId}-${hash}.pdf` } : {}),
      sourceOutcome: { status: available ? 'ready' : 'restricted', requestedFormat: 'pdf', label: 'Current outcome', detail: 'Current package validation', nextAction: 'Open source links' } })) };
  if (fault === 'foreign member') report.items[0].searchId = 'FOREIGN';
  if (fault === 'duplicate member') report.items[0] = report.items[1];
  if (fault === 'wrong scope') report.id += 'FOREIGN';
  if (fault === 'wrong run') report.runID = 'FOREIGN';
  if (fault === 'false count') report.includedRecords--;
  if (fault === 'corrupt archive') archive[6] = 4;
  if (fault === 'changed version') report.items[0].sha256 = 'f'.repeat(64);
  if (fault === 'unexpected empty payload') archive = new Uint8Array([80, 75, 3, 4]);
  const header = new TextEncoder().encode(JSON.stringify(report)), prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, header.length);
  return new Response(new Blob([prefix, header, archive]), { headers: { 'Content-Type': 'application/vnd.litradock.pdf-download' } });
}
it.each(['batch', 'plan'])('%s package uses final outcomes after earlier ready status', async kind => {
  const ids = Array.from({ length: kind === 'batch' ? 2 : 11 }, (_, i) => `S${i}`), id = kind === 'batch' ? 'B1' : 'PLN-00000000000000000000000000000001';
  let available = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/exports')) { expect(JSON.parse(String(init.body)).format).toBe('pdf-download'); return packageResponse(kind, id, ids, available); }
    return json(kind === 'batch' ? { id } : { planID: id, revision: 1, selectedCount: ids.length, affectedCount: 0, state: 'active' });
  }));
  const request = await intent(ids), prior = { items: ids.map(id => ({ id, article: { SearchId: id }, ready: true, pending: false, reason: '', hash, bytes: bytes.length, format: 'PDF', mediaType: 'application/pdf' })), ready: ids.length, pending: 0, unresolved: 0 };
  const positive = await pdfFile(request, prior, signal()); expect(positive.blob?.size).toBe(7); expect(positive.status.ready).toBe(ids.length);
  available = false;
  const final = await pdfFile(request, prior, signal()); expect(final.blob).toBeNull(); expect(final.status).toMatchObject({ ready: 0, pending: 0, unresolved: ids.length });
  expect(final.status.items.every(i => i.outcome?.status === 'restricted' && !i.hash)).toBe(true);
});
it.each(['foreign member', 'duplicate member', 'wrong scope', 'wrong run', 'false count', 'corrupt archive', 'changed version', 'unexpected empty payload'])('rejects final package %s', async fault => {
  const ids = Array.from({ length: 11 }, (_, i) => `S${i}`), id = 'PLN-00000000000000000000000000000001';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/exports') ? packageResponse('plan', id, ids, fault !== 'unexpected empty payload', fault) : json({ planID: id, revision: 1, selectedCount: ids.length, affectedCount: 0, state: 'active' })));
  const request = await intent(ids), prior = { items: ids.map(id => ({ id, article: { SearchId: id }, ready: true, pending: false, reason: '', hash, bytes: bytes.length, format: 'PDF', mediaType: 'application/pdf' })), ready: ids.length, pending: 0, unresolved: 0 };
  await expect(pdfFile(request, prior, signal())).rejects.toThrow('did not match');
});
