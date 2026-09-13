import { afterEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { PlanController } from "./controller";
import { detail, summary } from "./fixtures.test-support";
import { exportFixture } from "./export-fixture.test-support";
import { exportPlan } from "./exports";

const models: PlanController[] = [];
const saved = () => ({ ...summary(), scopeKind: "saved_set" as const, runID: "", sourceRunIDs: ["R1", "R2"], state: "partial" });
const page = () => ({ ...detail(), plan: saved() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function model() { const model = new PlanController("L", "R1", sessionGeneration(), () => {}); models.push(model); return model; }
afterEach(() => { models.splice(0).forEach(model => model.dispose()); vi.unstubAllGlobals(); clearSession(); });

it("saved-set lost response freezes exact format, ordered members and UUID across run change, then refreshes receipt with GET", async () => {
  setSession({ csrf: "SYNTHETIC" }); const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new Error("SYNTHETIC lost reply");
      return json({ planID: "synthetic-plan", revision: 1 });
    }
    return json(url.includes("/synthetic-plan?") ? page() : { plans: [saved()], total: 1, offset: 0, limit: 25 });
  }));
  const controller = model(), members = [{ searchID: "S1", runIDs: ["R2", "R1"] }];
  await controller.createSavedSet(members, "pdf");
  members[0].runIDs.push("changed"); controller.changeRun("R3");
  await controller.createSavedSet([{ searchID: "changed", runIDs: ["R3"] }], "xml");
  expect(bodies).toHaveLength(1); await controller.retrySubmission();
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toEqual({ requestID: expect.any(String), scopeKind: "saved_set", members: [{ searchID: "S1", runIDs: ["R1", "R2"] }], format: "pdf" });
  expect(controller.state.page?.plan.scopeKind).toBe("saved_set");
  controller.changeRun("R4"); await controller.read("synthetic-plan"); expect(bodies).toHaveLength(2);
  await controller.createSavedSet([{ searchID: "changed", runIDs: ["R4"] }], "xml");
  expect(bodies[2].requestID).not.toBe(bodies[0].requestID); expect(bodies[2].format).toBe("xml");
});

it.each([200, 401, 503])("late single-run%d body cannot clear a newer saved-set busy/error/session", async status => {
  setSession({ csrf: "A" }); let release!: (value: string) => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => ({ status, ok: status === 200, text: () => { started(); return new Promise<string>(resolve => { release = resolve; }); } })));
  const controller = model(); const old = controller.read("old"); await ready;
  controller.changeRun("R2");
  let releaseNew!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { releaseNew = resolve; })));
  const newer = controller.read("synthetic-plan");
  release(JSON.stringify(status === 200 ? { ...detail(), plan: { ...summary(), planID: "old" } } : { error: "SYNTHETIC old" }));
  await old; expect(controller.state.busy).toBe(true); expect(controller.state.error).toBe("");
  const generation = sessionGeneration(); releaseNew(json(page())); await newer;
  expect(controller.state.page?.plan.scopeKind).toBe("saved_set"); expect(controller.state.busy).toBe(false); expect(sessionGeneration()).toBe(generation);
});

it("saved-set metadata preserves exact bytes and source identities without a fictitious run", async () => {
  const data: any = exportFixture(); data.plan.scopeKind = "saved_set"; data.plan.runID = ""; data.plan.sourceRunIDs = ["R1", "R2"];
  data.research.records.forEach((record: any) => { record.runIds = ["R1", "R2"]; });
  const bytes = JSON.stringify(data);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "application/json" } })));
  const identity = { planID: "P1", runID: "", selectedCount: 3, scopeKind: "saved_set" as const, sourceRunIDs: ["R1", "R2"] };
  expect(await (await exportPlan("L", identity, "json", sessionGeneration(), new AbortController().signal)).blob.text()).toBe(bytes);
  await expect(exportPlan("L", { ...identity, sourceRunIDs: ["R3"] }, "json", sessionGeneration(), new AbortController().signal)).rejects.toThrow();
});

it("disabled admission409 clears uncertain submission without automatic retry or hiding saved plans", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? json({ error: "Saved-set admission disabled" }, 409) : json({ plans: [saved()], total: 1, offset: 0, limit: 25 }));
  vi.stubGlobal("fetch", fetch); const controller = model();
  await controller.createSavedSet([{ searchID: "S", runIDs: ["R1"] }], "pdf");
  expect(controller.state.pending).toBeNull(); expect(controller.state.catalog.plans).toHaveLength(1);
  await controller.retrySubmission(); expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it("run change between confirmed saved-set receipt and delayed detail preserves the owned operation", async () => {
  let release!: (response: Response) => void, start!: () => void;
  const reading = new Promise<void>(resolve => { start = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") return json({ planID: "synthetic-plan", revision: 1 });
    if (url.includes("/synthetic-plan?")) { start(); return new Promise<Response>(resolve => { release = resolve; }); }
    return json({ plans: [saved()], total: 1, offset: 0, limit: 25 });
  }));
  const controller = model(); const creation = controller.createSavedSet([{ searchID: "S", runIDs: ["R1"] }], "pdf");
  await reading; expect(controller.state.pending).toBeNull(); expect(controller.changeRun("R2")).toBe(false);
  expect(controller.state.busy).toBe(true); release(json(page())); await creation;
  expect(controller.state.page?.plan.planID).toBe("synthetic-plan"); expect(controller.state.busy).toBe(false);
});

it.each([[], ["R3"], ["R1", "R1"]].map(runIds => ({ runIds })))("saved-set export rejects missing, foreign or duplicate record provenance $runIds", async ({ runIds }) => {
  const data: any = exportFixture(); Object.assign(data.plan, { scopeKind: "saved_set", runID: "", sourceRunIDs: ["R1", "R2"] });
  data.research.records.forEach((record: any) => { record.runIds = ["R1", "R2"]; }); data.research.records[0].runIds = runIds;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })));
  await expect(exportPlan("L", { ...data.plan }, "json", sessionGeneration(), new AbortController().signal)).rejects.toThrow();
});
