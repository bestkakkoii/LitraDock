import { afterEach, expect, it, vi } from "vitest";
import { ApiError, clearSession, sessionGeneration, setSession } from "../api";
import { exportPlan, validatePlanMetadata, exportFailure } from "./exports";
import { exportFixture } from "./export-fixture.test-support";

const identity = { planID: "P1", runID: "R1", selectedCount: 3 };
const fixture = () => new Response(JSON.stringify(exportFixture()), { headers: { "Content-Type": "application/json; charset=utf-8" } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); clearSession(); });

it.each([1, 3, 100])("accepts the complete ordered %i-member envelope without normalizing metadata", async count => {
  const data = exportFixture("P/α", count), bytes = JSON.stringify(data);
  setSession({ csrf: "SYNTHETIC" }); const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(bytes, { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const result = await exportPlan("L/中文", { ...identity, planID: "P/α", selectedCount: count }, "json", sessionGeneration(), new AbortController().signal);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("/api/libraries/L%2F%E4%B8%AD%E6%96%87/plans/P%2F%CE%B1/exports");
  expect(JSON.parse(String(init.body))).toEqual({ format: "json" }); expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("X-CSRF")).toBe("SYNTHETIC"); expect(init.credentials).toBe("same-origin");
  expect(await result.blob.text()).toBe(bytes); expect(result.filename).toBe("litradock-plan.json");
});

const mutations: Record<string, (value: any) => void> = {
  zero: value => Object.assign(value, exportFixture("P1", 0)),
  duplicate: value => { value.items[1].searchId = value.items[0].searchId; value.research.records[1].searchId = value.items[0].searchId; },
  order: value => value.research.records.reverse(),
  rank: value => { value.items[0].rank = 0; },
  count: value => { value.counts.members = 2; },
  savedCount: value => { value.research.counts.scopeRecords = 2; },
  foreign: value => { value.plan.planID = "FOREIGN"; },
  foreignRun: value => { value.plan.runID = "FOREIGN"; },
  foreignScope: value => { value.research.scope.planId = "FOREIGN"; },
  selectedScope: value => { value.research.scope.selection = "selected"; },
  falseAvailability: value => { value.items[0].availability = "included"; },
  falseRevalidation: value => { value.originalsRevalidated = true; },
  falseOriginal: value => { value.items[0].file = "originals/hidden.pdf"; },
  falseIncludedCount: value => { value.counts.includedRecords = 1; },
  missingNullableField: value => { delete value.items[0].acquisitionState; },
  phaseMismatch: value => { value.items[1].phase = "completed"; },
  error: value => { value.error = "SYNTHETIC failure"; },
};
it.each(Object.keys(mutations))("rejects %s rather than saving misleading whole-plan metadata", name => {
  const value = exportFixture(); mutations[name](value);
  expect(() => validatePlanMetadata(value, identity)).toThrow();
});
it("rejects101 members even with internally matching counts", () => {
  expect(() => validatePlanMetadata(exportFixture("P1", 101), { ...identity, selectedCount: 101 })).toThrow();
});
it.each(["wrong media", "invalid UTF8", "error", "lost"])("rejects %s without automatic export retry", async failure => {
  const fetch = vi.fn(async () => {
    if (failure === "lost") throw new TypeError("Synthetic lost response");
    return new Response(failure === "invalid UTF8" ? new Uint8Array([255]) : failure === "error" ? '{"error":"SYNTHETIC"}' : JSON.stringify(exportFixture()),
      { headers: { "Content-Type": failure === "wrong media" ? "text/html" : "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(exportPlan("L", identity, "json", sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it("passes exact ZIP bytes and safe filename but does not pretend to parse archive counts", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 1]); // signature-only test, not valid ZIP evidence
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "application/zip" } })));
  const result = await exportPlan("L", identity, "zip", sessionGeneration(), new AbortController().signal);
  expect(result.filename).toBe("litradock-plan-originals.zip"); expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
});

for (const status of [200, 401, 503]) it.each(["plan", "run", "library", "account"])(`held${status} body rejects stale %s scope and preserves newer positive control`, async change => {
  setSession({ csrf: "SYNTHETIC-A" }); const generation = sessionGeneration(), abort = new AbortController();
  let release!: (body: string | Blob) => void, started!: () => void;
  const consuming = new Promise<void>(resolve => { started = resolve; });
  const consume = () => { started(); return new Promise<string | Blob>(resolve => { release = resolve; }); };
  vi.stubGlobal("fetch", vi.fn(async () => ({ status, ok: status === 200, blob: consume, text: consume })));
  const pending = exportPlan("L", identity, "json", generation, abort.signal); await consuming;
  if (change === "account") setSession({ csrf: "SYNTHETIC-B" }); else abort.abort();
  const newer = sessionGeneration(); release(status === 200 ? await fixture().blob() : "SYNTHETIC error");
  await expect(pending).rejects.toThrow("Session changed"); expect(sessionGeneration()).toBe(newer);
  vi.stubGlobal("fetch", vi.fn(fixture));
  expect((await exportPlan("NEW", identity, "json", newer, new AbortController().signal)).filename).toBe("litradock-plan.json");
});
it("post-validation byte read remains fenced", async () => {
  const blob = await fixture().blob(), bytes = await blob.arrayBuffer(), abort = new AbortController();
  let release!: (bytes: ArrayBuffer) => void, start!: () => void;
  const reading = new Promise<void>(resolve => { start = resolve; });
  vi.spyOn(blob, "arrayBuffer").mockImplementation(() => { start(); return new Promise(resolve => { release = resolve; }); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, blob: async () => blob })));
  const pending = exportPlan("L", identity, "json", sessionGeneration(), abort.signal); await reading; abort.abort(); release(bytes);
  await expect(pending).rejects.toThrow("context changed");
});
it.each(["2", "9999999", "-1", "<script>", "Sun, 13 Sep 2026 00:00:02 GMT"])("429 Retry-After %s is bounded advisory, never automatic", async value => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
  const fetch = vi.fn(async () => new Response("SYNTHETIC busy", { status: 429, headers: { "Retry-After": value } })); vi.stubGlobal("fetch", fetch);
  const error = await exportPlan("L", identity, "zip", sessionGeneration(), new AbortController().signal).catch(error => error);
  expect(error).toBeInstanceOf(ApiError); expect(error.retryAfter).toBe(value === "2" || value.startsWith("Sun") ? 2 : undefined);
  expect(exportFailure(error)).toContain("No automatic retry"); expect(exportFailure(error)).not.toContain("script"); expect(fetch).toHaveBeenCalledOnce();
});
it("current401 still invalidates and409 keeps explicit alternatives", async () => {
  setSession({ csrf: "SYNTHETIC" }); const generation = sessionGeneration();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("SYNTHETIC expired", { status: 401 })));
  await expect(exportPlan("L", identity, "json", generation, new AbortController().signal)).rejects.toThrow("expired");
  expect(sessionGeneration()).toBe(generation + 1);
  expect(exportFailure(new ApiError(409, "SYNTHETIC"))).toContain("child batch");
});
