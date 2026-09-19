// SYNTHETIC transport schedules. Assertions describe externally observable state.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "./api";
import { RunSelectionController, type PendingSelection, validateSelection } from "./runSelection";

const snapshot = (revision = 11, ids = ["S1", "S2"]) => ({ runID: "R1", revision, defaultSelected: true,
  savedCount: 2, selectedCount: ids.length, selectedIDs: ids, selectedRecords: ids.map(SearchId => ({ SearchId, Title: "SYNTHETIC" })),
  recordsComplete: true, recordsReason: "", canEdit: true, selectionLimit: 1000, detailLimit: 100 });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const models: RunSelectionController[] = [];
function model(pending: PendingSelection | null = null) {
  const changed = vi.fn(), remember = vi.fn(), scope = new AbortController();
  const controller = new RunSelectionController("L/1", "R1", sessionGeneration(), scope.signal, changed, remember, pending);
  models.push(controller); return { controller, changed, remember, scope };
}
beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { models.splice(0).forEach(m => m.dispose()); vi.unstubAllGlobals(); clearSession(); });

it("keeps all 20000 saved selections exact without expanding the 100-record PDF detail boundary", () => {
  const selectedIDs = Array.from({ length: 20000 }, (_, i) => `SYNTHETIC-${i}`);
  const value = { ...snapshot(), savedCount: 20000, selectedCount: 20000, selectedIDs, selectionLimit: 20000,
    selectedRecords: [], recordsComplete: false, recordsReason: "Choose up to 100 saved records for PDF details." };
  expect(validateSelection(value, "R1").selectedIDs).toEqual(selectedIDs);
  expect(() => validateSelection({ ...value, selectionLimit: 1000 }, "R1")).toThrow();
  expect(() => validateSelection({ ...value, savedCount: 20001 }, "R1")).toThrow();
  expect(() => validateSelection({ ...value, recordsComplete: true, selectedRecords: selectedIDs.map(SearchId => ({ SearchId })) }, "R1")).toThrow();
  const subset = selectedIDs.slice(0, 100);
  expect(validateSelection({ ...value, selectedIDs: subset, selectedCount: 100, recordsComplete: true,
    selectedRecords: subset.map(SearchId => ({ SearchId })) }, "R1").recordsComplete).toBe(true);
});
it.each([true, false])("new saved metadata preserves confirmed defaultSelected=%s and exact exceptions", async defaultSelected => {
  const { controller } = model(); let count = 1000;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const selectedIDs = defaultSelected ? Array.from({ length: count - 1 }, (_, i) => `S${i + 2}`) : ["S2"];
    return response({ ...snapshot(count), defaultSelected, savedCount: count, selectedCount: selectedIDs.length, selectedIDs,
      selectedRecords: defaultSelected ? [] : [{ SearchId: "S2" }], recordsComplete: !defaultSelected,
      recordsReason: defaultSelected ? "SYNTHETIC bounded details" : "", selectionLimit: 20000 });
  }));
  await controller.load(); count = 1200; await controller.load();
  expect(controller.state.snapshot?.defaultSelected).toBe(defaultSelected);
  expect(controller.state.snapshot?.selectedIDs).not.toContain("S1");
  expect(controller.state.snapshot?.selectedCount).toBe(defaultSelected ? 1199 : 1);
});

it.each([
  { selectedCount: 1 }, { selectedIDs: ["S1", "S1"] }, { savedCount: 1001 }, { runID: "FOREIGN" },
  { selectedRecords: [{ SearchId: "FOREIGN" }, { SearchId: "S2" }] }, { revision: 0 },
  { recordsComplete: false }, { selectedRecords: [] }, { detailLimit: 1000 },
])("rejects inconsistent snapshots %j", patch => {
  expect(() => validateSelection({ ...snapshot(), ...patch }, "R1")).toThrow();
});
it("preserves exact committed-but-lost request on retry and rereads newer server choices", async () => {
  const posts: string[] = []; let saved = snapshot(), lost = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/libraries/L%2F1/runs/R1/selection");
    if (init.method !== "POST") return response(saved);
    expect(new Headers(init.headers).get("X-CSRF")).toBe("SYNTHETIC");
    posts.push(String(init.body)); const body = JSON.parse(String(init.body));
    saved = snapshot(12, []);
    if (lost) { lost = false; throw new TypeError("SYNTHETIC connection lost after commit"); }
    saved = snapshot(13, ["S2"]); // another tab changed after our receipt
    return response({ runID: "R1", requestID: body.requestID, revision: 12 });
  }));
  const { controller } = model(); await controller.load(); await controller.apply({ action: "none" });
  expect(controller.state.phase).toBe("uncertain"); expect(controller.state.snapshot?.selectedCount).toBe(2);
  await controller.apply({ action: "all" }); expect(posts).toHaveLength(1);
  await controller.retry(); expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]);
  expect(controller.state.snapshot?.selectedIDs).toEqual(["S2"]); expect(controller.state.pending).toBeNull();
});
it.each([409, 400, 403, 404, 422])("rejected %i retains intent, forbids silent overwrite and requires explicit reload", async status => {
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_: string, init: RequestInit) => {
    if (init.method === "POST") { writes++; return response({ error: "SYNTHETIC" }, status); }
    return response(snapshot());
  }));
  const { controller } = model(); await controller.load(); await controller.apply({ action: "set", ids: ["S1"], selected: false });
  expect(controller.state.pending?.body.action).toBe("set"); expect(controller.state.phase).toBe(status === 409 ? "conflict" : "rejected");
  await controller.retry(); await controller.apply({ action: "all" }); expect(writes).toBe(1);
  await controller.load(true); expect(controller.state.phase).toBe("ready"); expect(controller.state.pending).toBeNull();
});
it("a confirmed receipt plus failed reread retries only GET", async () => {
  let reads = 0, writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_: string, init: RequestInit) => {
    if (init.method === "POST") { writes++; return response({ runID: "R1", requestID: JSON.parse(String(init.body)).requestID, revision: 12 }); }
    if (++reads === 2) return response({}, 503);
    return response(snapshot(reads > 2 ? 12 : 11, reads > 2 ? [] : ["S1", "S2"]));
  }));
  const { controller } = model(); await controller.load(); await controller.apply({ action: "none" });
  expect(controller.state.phase).toBe("refresh"); await controller.retry();
  expect(writes).toBe(1); expect(controller.state.snapshot?.selectedCount).toBe(0);
});
it.each(["capacity", "revision"])("a %s refusal does not invent changed choices and reload observes actual admission", async reason => {
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_: string, init: RequestInit) => {
    if (init.method === "POST") {
      writes++;
      return response({ error: "SYNTHETIC untrusted error content" }, 409);
    }
    return response(writes && reason === "capacity" ? { ...snapshot(), canEdit: false } :
      writes ? snapshot(12, ["S2"]) : snapshot());
  }));
  const { controller } = model(); await controller.load(); await controller.apply({ action: "none" });
  expect(controller.state.phase).toBe("conflict");
  expect(controller.state.error).toContain("current state and availability");
  expect(controller.state.error).not.toMatch(/changed elsewhere|SYNTHETIC/);
  await controller.retry(); expect(writes).toBe(1);
  await controller.load(true);
  expect(controller.state.snapshot?.revision).toBe(reason === "capacity" ? 11 : 12);
  expect(controller.state.snapshot?.selectedIDs).toEqual(reason === "capacity" ? ["S1", "S2"] : ["S2"]);
  expect(controller.state.snapshot?.canEdit).toBe(reason !== "capacity");
  await controller.apply({ action: "all" });
  expect(writes).toBe(reason === "capacity" ? 1 : 2);
});
it.each(["scope", "session"])("held old %s POST body cannot publish or invalidate a new session", async change => {
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (_: string, init: RequestInit) => {
    if (init.method !== "POST") return response(snapshot());
    const body = JSON.parse(String(init.body));
    return new Response(new ReadableStream({ start(c) { release = () => { if (!c.desiredSize) return; c.enqueue(new TextEncoder().encode(JSON.stringify({ runID: "R1", requestID: body.requestID, revision: 12 }))); c.close(); }; } }));
  }));
  const { controller, changed, scope } = model(); await controller.load(); const write = controller.apply({ action: "none" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  if (change === "scope") scope.abort(); else setSession({ csrf: "SYNTHETIC-B" });
  const calls = changed.mock.calls.length, generation = sessionGeneration(); release(); await write;
  expect(changed).toHaveBeenCalledTimes(calls); expect(sessionGeneration()).toBe(generation);
});
it("serializes rapid clicks without inventing another request and retains captured IDs", async () => {
  let release!: () => void; const posts: unknown[] = []; let saved = snapshot();
  vi.stubGlobal("fetch", vi.fn(async (_: string, init: RequestInit) => {
    if (init.method !== "POST") return response(saved);
    const body = JSON.parse(String(init.body)); posts.push(body);
    await new Promise<void>(resolve => { release = resolve; }); saved = snapshot(12, ["S2"]);
    return response({ runID: "R1", requestID: body.requestID, revision: 12 });
  }));
  const { controller } = model(); await controller.load(); const ids = ["S1"];
  const write = controller.apply({ action: "set", ids, selected: false }); ids[0] = "S2";
  await controller.apply({ action: "all" }); await controller.load(true);
  expect(controller.state.phase).toBe("saving"); expect(controller.state.snapshot?.selectedCount).toBe(2);
  release(); await write; expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ ids: ["S1"], selected: false, revision: 11 });
});
