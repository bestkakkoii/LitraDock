// @vitest-environment jsdom
// SYNTHETIC isolated server state; no source or PDF requests.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, type Run, sessionGeneration, setSession } from "./api";
import { useSavedSelection } from "./savedSelection";

const article = (i: number) => ({ SearchId: `SYNTHETIC-${i}`, Title: `SYNTHETIC α 中文 ${i}` });
const caps = { durableSelectionEnabled: true, selectionWriteEnabled: true, selectionRecordLimit: 1000 };
let root: Root, host: HTMLDivElement, selection: ReturnType<typeof useSavedSelection>;
let count = 101, defaultSelected = true, revision = 7, offset = 0;
let exceptions: Map<string, boolean>, posts: unknown[], scope: AbortController;
let readEnabled = true, writeEnabled = true, refreshVersion = 0;
function snapshot(id = "R1") {
  const selected = Array.from({ length: count }, (_, i) => article(i)).filter(a => exceptions.get(a.SearchId) ?? defaultSelected);
  return { runID: id, revision, savedCount: count, selectedCount: selected.length, defaultSelected,
    selectedIDs: selected.map(a => a.SearchId), selectedRecords: selected.length <= 100 ? selected : [],
    recordsComplete: selected.length <= 100, recordsReason: selected.length <= 100 ? "" : "SYNTHETIC detail limit", canEdit: true, selectionLimit: 1000, detailLimit: 100 };
}
function Harness({ id = "R1", library = "L1", state = "partial" }: { id?: string; library?: string; state?: string }) {
  const run: Run = { run_id: id, input: "SYNTHETIC", total: 25001, fetched: count, state };
  selection = useSavedSelection(library, run, sessionGeneration(), scope.signal,
    Array.from({ length: Math.min(25, Math.max(0, count - offset)) }, (_, i) => article(i + offset)),
    { ...caps, durableSelectionEnabled: readEnabled, selectionWriteEnabled: writeEnabled }, refreshVersion);
  return <span>{selection.count}</span>;
}
const render = (props = {}) => act(async () => root.render(<StrictMode><Harness {...props} /></StrictMode>));
const settle = async () => { for (let n = 0; n < 30 && !selection.ready; n++) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); expect(selection.error).toBe(""); expect(selection.ready).toBe(true); };
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("Blob", (await vi.importActual<{ Blob: typeof Blob }>("node:buffer")).Blob);
  setSession({ csrf: "SYNTHETIC" }); count = 101; offset = 0; revision = 7; defaultSelected = true;
  readEnabled = writeEnabled = true; refreshVersion = 0; exceptions = new Map(); posts = []; scope = new AbortController();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/runs\/[^/]+\/selection$/);
    const id = url.split("/").at(-2)!;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body);
      expect(body.revision).toBe(revision);
      if (body.action === "set") for (const id of body.ids) exceptions.set(id, body.selected);
      else { defaultSelected = body.action === "all"; exceptions.clear(); }
      return new Response(JSON.stringify({ runID: id, requestID: body.requestID, revision: ++revision }));
    }
    return new Response(JSON.stringify(snapshot(id)));
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); clearSession(); });
it.each([0, 1, 99, 100, 101, 999, 1000])("StrictMode restores all %i compact IDs with bounded details", async size => {
  count = size; await render(); await settle();
  expect(selection.count).toBe(size); expect(selection.total).toBe(size);
  expect(selection.ids).toEqual(Array.from({ length: size }, (_, i) => article(i).SearchId));
  expect(selection.records.length).toBe(size <= 100 ? size : 0);
  expect(selection.detailsReady).toBe(size <= 100); expect(posts).toEqual([]);
});
it("page additions and removals preserve other pages; remount recovers durable exceptions", async () => {
  await render(); await settle(); await act(async () => selection.deselectAll()); await settle();
  await act(async () => selection.selectPage()); await settle(); expect(selection.count).toBe(25);
  offset = 25; await render(); await act(async () => selection.selectPage()); await settle(); expect(selection.count).toBe(50);
  await act(async () => selection.deselectPage()); await settle(); expect(selection.count).toBe(25);
  await act(async () => root.unmount()); root = createRoot(host); offset = 0; await render(); await settle();
  expect(selection.count).toBe(25); expect(selection.selected.has(article(24).SearchId)).toBe(true);
  await act(async () => selection.toggle(article(0))); await settle(); expect(selection.count).toBe(24);
});
it("continuation refresh follows stored default and explicit exceptions, never a browser default", async () => {
  count = 1; await render(); await settle();
  await act(async () => selection.toggle(article(0))); await settle();
  count = 100; revision++; await render({ state: "running" }); await settle();
  expect(selection.count).toBe(99); expect(selection.selected.has(article(0).SearchId)).toBe(false);
  await act(async () => selection.deselectAll()); await settle();
  count = 101; revision++; await render(); await settle(); expect(selection.count).toBe(0);
  await act(async () => selection.selectAll()); await settle();
  count = 1000; revision++; await render({ state: "cancelled" }); await settle(); expect(selection.count).toBe(1000);
});
it("scope navigation and abort never post none as cleanup", async () => {
  await render(); await settle(); await render({ id: "R2", library: "L2" }); await settle();
  expect(posts).toEqual([]); await act(async () => scope.abort());
  expect(selection.ready).toBe(false); expect(selection.count).toBe(0); expect(posts).toEqual([]);
});
it("capability absence is unavailable; read-only still restores choices without writes", async () => {
  readEnabled = false; await render(); expect(selection.unavailable).toBe(true); expect(selection.ready).toBe(false);
  expect(fetch).not.toHaveBeenCalled(); readEnabled = true; writeEnabled = false; await render(); await settle();
  expect(selection.canEdit).toBe(false); await act(async () => selection.deselectAll()); expect(posts).toEqual([]);
});
it.each(["run", "library", "session"])("held old-%s read cannot replace the newer selection or clear its session", async change => {
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { release = () => { if (!c.desiredSize) return; c.enqueue(new TextEncoder().encode(JSON.stringify(snapshot()))); c.close(); }; } }))));
  // The first StrictMode read is aborted; wait for the active read's release.
  await render(); await act(async () => { await vi.waitFor(() => expect(release).toBeTypeOf("function")); });
  const oldRelease = release;
  count = 1;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot(change === "run" ? "R2" : "R1")))));
  if (change === "session") setSession({ csrf: "SYNTHETIC-B" });
  await render({ id: change === "run" ? "R2" : "R1", library: change === "library" ? "L2" : "L1" }); await settle();
  const newer = sessionGeneration(); await act(async () => oldRelease());
  expect(selection.count).toBe(1); expect(selection.error).toBe(""); expect(sessionGeneration()).toBe(newer);
});

it("explicit same-run reopen reads another tab's newer choices with no write", async () => {
  count = 100; await render(); await settle(); expect(selection.count).toBe(100);
  defaultSelected = false; revision++; refreshVersion++;
  await render(); await settle(); expect(selection.count).toBe(0); expect(posts).toEqual([]);
});
