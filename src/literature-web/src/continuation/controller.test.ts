// SYNTHETIC transport schedules, not native handler/provider qualification.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { Continuation, states, validateContinuation, validateReceipt } from "./api";
import { SearchController } from "./controller";
const id = `RUN-${"1".repeat(32)}`, other = `RUN-${"2".repeat(32)}`;
const status = (extra: Partial<Continuation> = {}): Continuation => ({ runID: id, revision: 7, state: "ready", windowLimit: 1000, windowCount: 1000,
  processedCount: 1, savedCount: 1, missingCount: 0, providerTotal: 25001, pageSize: 100, attempts: 1,
  canContinue: true, canCancel: false, canRetry: false, reason: "SYNTHETIC", snapshotAt: "2026-09-13T00:00:00Z", ...extra });
const page = (runID = id) => ({ run: { run_id: runID, input: "SYNTHETIC 中文", state: "partial", fetched: 1, total: 25001 },
  continuation: status({ runID }), records: [{ SearchId: "SYNTHETIC-1" }], total: 1, offset: 0, limit: 25 });
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
const models: SearchController[] = [];
function model(scope = new AbortController()) {
  const publish = vi.fn(), onPage = vi.fn();
  const controller = new SearchController("L1", sessionGeneration(), publish, onPage, scope.signal);
  models.push(controller); return { controller, publish, onPage, scope };
}
beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { models.splice(0).forEach(m => m.dispose()); clearSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(states)("validates actual %s state, including an older replay revision", state => {
  expect(validateReceipt({ runID: id, revision: 1, state }, id)).toMatchObject({ state });
});
it.each([0, 1, 100, 101, 1000])("represents %i identities separately from provider totals", count => {
  expect(validateContinuation(status({ windowCount: count, processedCount: count, savedCount: count }), id)?.savedCount).toBe(count);
});
it("accepts absent legacy and pre-snapshot queued status; rejects impossible counts", () => {
  expect(validateContinuation(null, id)).toBeNull();
  expect(validateContinuation(status({ state: "queued", windowCount: 0, processedCount: 0, savedCount: 0, providerTotal: 0, snapshotAt: null }), id)?.snapshotAt).toBeNull();
  expect(() => validateContinuation(status({ savedCount: 2 }), id)).toThrow();
  expect(() => validateContinuation(status({ windowCount: 1001 }), id)).toThrow();
  expect(validateContinuation(status({ processedCount: 2, missingCount: 1, missingPMIDs: ["123"] }), id)?.missingPMIDs).toEqual(["123"]);
  expect(() => validateContinuation(status({ processedCount: 2, missingCount: 1, missingPMIDs: ["123/evil"] }), id)).toThrow();
});
it.each([{}, { runID: id }, { runID: id, revision: 0, state: "ready" }, { runID: other, revision: 1, state: "ready" },
  { runID: "RUN-malformed", revision: 1, state: "ready" }, { runID: id, revision: 1, state: "fictional" }].map(receipt => ({ receipt })))
  ("malformed200 $receipt retains exact continuation payload after navigation and changed action", async ({ receipt }) => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { posts.push(String(init.body)); return json(receipt); }));
    const { controller } = model(); await controller.action(status(), "continue"); controller.navigate();
    await controller.action(status({ canCancel: true }), "cancel"); expect(posts).toHaveLength(1);
    await controller.retry(); expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]);
    expect(JSON.parse(posts[0])).toMatchObject({ revision: 7, action: "continue" }); expect(controller.state.pending).not.toBeNull();
  });
it.each(["invalidJSON", "lost", "empty"])("unconfirmed initial search %s freezes UUID/query/limit against edited intent", async mode => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    posts.push(String(init.body)); if (mode === "lost") throw new TypeError("SYNTHETIC transport loss");
    return mode === "invalidJSON" ? new Response("{") : json({});
  }));
  const { controller } = model(); await controller.search('"治療"[MeSH] AND αβ', 100);
  controller.navigate(); await controller.search("different", 10); expect(posts).toHaveLength(1);
  await controller.retry(); expect(posts[1]).toBe(posts[0]);
  expect(JSON.parse(posts[0])).toMatchObject({ query: '"治療"[MeSH] AND αβ', limit: 100 });
});
it("definite validation rejection releases the draft, while503 retains the exact uncertain intent", async () => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    posts.push(String(init.body)); return json({ error: "SYNTHETIC admission" }, posts.length === 1 ? 400 : 503);
  }));
  const { controller } = model(); await controller.search("   ", 5);
  expect(controller.state.pending).toBeNull(); expect(controller.state.error).toContain("not admitted");
  await controller.search("asthma[MeSH Terms]", 5);
  expect(posts).toHaveLength(2); expect(JSON.parse(posts[1]).query).toBe("asthma[MeSH Terms]");
  expect(JSON.parse(posts[1]).requestID).not.toBe(JSON.parse(posts[0]).requestID);
  expect(controller.state.pending).not.toBeNull(); await controller.retry(); expect(posts[2]).toBe(posts[1]);
});
it("conflicting cancellation refreshes saved status and preserves an actionable notice", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) =>
    init.method === "POST" ? json({ error: "Run changed" }, 409) : json(page())));
  const { controller } = model(); await controller.action(status({ canCancel: true }), "cancel");
  expect(controller.state.pending).toBeNull(); expect(controller.state.notice).toContain("not applied");
  expect(controller.state.notice).toContain("choose the action again");
});
it.each(["search", "continuation"])("valid %s receipt plus GET503 retains known run and only GET recovers", async kind => {
  const posts: string[] = []; let unavailable = true;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { posts.push(String(init.body)); return json(kind === "search" ? { id } : { runID: id, revision: 1, state: "ready" }); }
    return unavailable ? json({ error: "SYNTHETIC GET" }, 503) : json(page());
  }));
  const { controller } = model();
  if (kind === "search") await controller.search("SYNTHETIC", 10); else await controller.action(status(), "continue");
  expect(controller.state.confirmed).toBe(id); expect(controller.state.pending).toBeNull();
  await controller.search("new", 10); await controller.retry(); expect(posts).toHaveLength(1);
  unavailable = false; await controller.read(id); expect(controller.state.confirmed).toBeNull(); expect(posts).toHaveLength(1);
});
it.each([200, 401, 503])("held old %i body after run/library/account retirement cannot publish or release newer busy", async code => {
  for (const boundary of ["run", "library", "account"]) {
    let release!: (body: string) => void, newer!: (body: string) => void;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: ++calls === 1 ? code : 200, ok: calls !== 1 || code === 200,
      text: () => new Promise<string>(resolve => { if (calls === 1) release = resolve; else newer = resolve; }) })));
    const old = model(); const first = old.controller.action(status(), "continue");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (boundary === "run") old.controller.navigate();
    if (boundary === "library") old.scope.abort();
    if (boundary === "account") setSession({ csrf: "SYNTHETIC-B" });
    const current = boundary === "run" ? old : model(); const next = current.controller.read(other);
    await vi.waitFor(() => expect(newer).toBeTypeOf("function")); const generation = sessionGeneration();
    release(JSON.stringify({ runID: id, revision: 1, state: "ready" })); await first;
    expect(sessionGeneration()).toBe(generation); expect(current.controller.state.busy).toBe(true);
    expect(current.controller.state.error).toBe(""); expect(old.onPage).not.toHaveBeenCalled();
    newer(JSON.stringify(page(other))); await next; expect(current.onPage).toHaveBeenCalledOnce();
  }
});
it("a current401 retires the session; GET reopen never posts and invalid capabilities never admit", async () => {
  const fetch = vi.fn(async () => json({ error: "SYNTHETIC expired" }, 401)); vi.stubGlobal("fetch", fetch);
  const { controller } = model(); const generation = sessionGeneration();
  await controller.action(status({ canContinue: false }), "continue"); expect(fetch).not.toHaveBeenCalled();
  await controller.read(id); expect(sessionGeneration()).toBeGreaterThan(generation);
});
it("caps automatic queued/running status reads at120 without admitting another page", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => json({ ...page(), continuation: status({ state: "running", canContinue: false, canCancel: true }) }));
  vi.stubGlobal("fetch", fetch); const { controller } = model(); await controller.read(id);
  await vi.advanceTimersByTimeAsync(300000);
  expect(fetch).toHaveBeenCalledTimes(120); expect(controller.state.notice).toContain("Automatic status refresh stopped");
  expect(fetch.mock.calls.every(call => (call as unknown as [string, RequestInit])[1].method !== "POST")).toBe(true);
  await controller.read(id); expect(fetch).toHaveBeenCalledTimes(121);
});
