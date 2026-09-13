// @vitest-environment jsdom
// Isolated synthetic saved-record and response-consumption schedules.
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, Run, sessionGeneration, setSession } from "./api";
import { enumerateSaved, useSavedSelection } from "./savedSelection";

const record = (i: number) => ({ SearchId: `SYNTHETIC-${i}`, Title: `SYNTHETIC α 中文 ${i}` });
const run = (count: number, id = "R1"): Run => ({ run_id: id, input: "SYNTHETIC", total: 25001, fetched: count, state: "partial" });
const page = (count: number, offset = 0, length = count, id = "R1") => ({ run: run(count, id), records: Array.from({ length }, (_, i) => record(offset + i)), total: count, offset, limit: 100 });
beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });
it.each([0, 1, 10, 11, 100])("enumerates exactly %i saved IDs, not the 25001 provider matches", async count => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(page(count)))); vi.stubGlobal("fetch", fetch);
  const selected = await enumerateSaved("L1", run(count), sessionGeneration(), new AbortController().signal);
  expect(selected.size).toBe(count); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toBeDefined();
});
it("uses bounded saved GET pages; incomplete, duplicate and oversized sets fail closed", async () => {
  let replies = [page(11, 0, 5), page(11, 5, 6)];
  const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()))); vi.stubGlobal("fetch", fetch);
  expect((await enumerateSaved("L1", run(11), sessionGeneration(), new AbortController().signal)).size).toBe(11);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const invalid of [page(11, 0, 0), { ...page(2), records: [record(0), record(0)] }, page(101)]) {
    replies = [invalid];
    await expect(enumerateSaved("L1", run(invalid.total), sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  }
});
it.each([200, 401])("rejects a held old-account body %i without clearing the new account", async status => {
  let release!: (body: string) => void;
  vi.stubGlobal("fetch", vi.fn(async () => ({ status, ok: status === 200, text: () => new Promise<string>(resolve => { release = resolve; }) })));
  const pending = enumerateSaved("L1", run(1), sessionGeneration(), new AbortController().signal);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  setSession({ csrf: "NEW" }); const newer = sessionGeneration();
  release(JSON.stringify(page(1)));
  await expect(pending).rejects.toThrow(); expect(sessionGeneration()).toBe(newer);
});

let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
it("default-all happens once, respects manual subsets and Deselect all across same-run refresh, resets on scope", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(page(11, 0, 11, url.includes("R2") ? "R2" : "R1")))));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  let selection!: ReturnType<typeof useSavedSelection>;
  const scope = new AbortController();
  function Harness({ id, library = "L1" }: { id: string; library?: string }) {
    selection = useSavedSelection(library, run(11, id), sessionGeneration(), scope.signal);
    return <span>{selection.selected.size}</span>;
  }
  await act(async () => root!.render(<Harness id="R1" />));
  expect(selection.selected.size).toBe(11);
  await act(async () => selection.toggle(record(0)));
  await act(async () => root!.render(<Harness id="R1" />));
  expect(selection.selected.size).toBe(10);
  await act(async () => selection.deselectAll());
  await act(async () => root!.render(<Harness id="R1" />));
  expect(selection.selected.size).toBe(0);
  await act(async () => selection.selectAll()); expect(selection.selected.size).toBe(11);
  await act(async () => root!.render(<Harness id="R2" library="L2" />));
  expect(selection.selected.size).toBe(11);
  await act(async () => scope.abort()); expect(selection.selected.size).toBe(0); expect(selection.ready).toBe(false);
});
it.each(["run", "library"])("a held old-%s enumeration cannot replace a newer complete selection", async change => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: (body: string) => void, first = true;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (first) { first = false; return { status: 200, ok: true, text: () => new Promise<string>(resolve => { release = resolve; }) }; }
    return new Response(JSON.stringify(page(1, 0, 1, change === "run" ? "R2" : "R1")));
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  let selection!: ReturnType<typeof useSavedSelection>;
  const scope = new AbortController();
  function Harness({ id, library }: { id: string; library: string }) {
    selection = useSavedSelection(library, run(id === "R2" || library === "L2" ? 1 : 11, id), sessionGeneration(), scope.signal);
    return <span>{selection.selected.size}</span>;
  }
  await act(async () => root!.render(<Harness id="R1" library="L1" />));
  expect(selection.loading).toBe(true); expect(selection.ready).toBe(false);
  await act(async () => root!.render(<Harness id={change === "run" ? "R2" : "R1"} library={change === "library" ? "L2" : "L1"} />));
  expect(selection.selected.size).toBe(1); expect(selection.ready).toBe(true);
  await act(async () => release(JSON.stringify(page(11))));
  expect(selection.selected.size).toBe(1); expect(selection.error).toBe(""); expect(selection.loading).toBe(false);
});
