// SYNTHETIC Fetch receipts; no server/source qualification.
import { afterEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { PlanController } from "./controller";
import { validateControlReceipt, validateCreateReceipt } from "./api";
import { detail, summary } from "./fixtures.test-support";
const id = "PLN-00000000000000000000000000000001", foreign = "PLN-00000000000000000000000000000002";
const valid = { planID: id, revision: 1, state: "active", selectedCount: 1, affectedCount: 0 };
const members = [{ searchID: "SYNTHETIC", runIDs: ["R1"] }];
const models: PlanController[] = [];
const model = () => { const value = new PlanController("L", "R1", sessionGeneration(), () => {}); models.push(value); return value; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { models.splice(0).forEach(value => value.dispose()); vi.unstubAllGlobals(); clearSession(); });
const malformed: Record<string, unknown> = {
  empty: {}, null: null, array: [], missing: { planID: id }, revision0: { ...valid, revision: 0 }, revision2: { ...valid, revision: 2 },
  missingRevision: { planID: id, state: "active", selectedCount: 1, affectedCount: 0 },
  malformedID: { ...valid, planID: "P-created" }, wrongIDType: { ...valid, planID: 123 }, uppercase: { ...valid, planID: `PLN-${"A".repeat(32)}` },
  wrongCount: { ...valid, selectedCount: 2 }, fractionalCount: { ...valid, selectedCount: 1.5 }, missingCount: { planID: id, revision: 1, state: "active", affectedCount: 0 },
  missingState: { planID: id, revision: 1, selectedCount: 1, affectedCount: 0 }, wrongState: { ...valid, state: "complete" }, affected: { ...valid, affectedCount: 1 },
};
it.each(Object.keys(malformed))("035-F1 %s retains original UUID/body across run/draft change and GET navigation", async name => {
  setSession({ csrf: "SYNTHETIC" }); const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { posts.push(String(init.body)); return json(malformed[name]); }
    return json({ error: "SYNTHETIC GET unavailable" }, 503);
  }));
  const controller = model(); await controller.createSavedSet(members, "pdf");
  expect(controller.state.pending?.kind).toBe("create"); expect(controller.state.confirmed).toBeNull();
  expect(controller.state.notice).not.toContain("confirmed");
  controller.changeRun("R2"); await controller.read(foreign);
  await controller.createSavedSet([{ searchID: "CHANGED", runIDs: ["R2"] }], "xml");
  expect(posts).toHaveLength(1); await controller.retrySubmission();
  expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]);
  expect(JSON.parse(posts[1])).toMatchObject({ scopeKind: "saved_set", members, format: "pdf" });
});
it("valid receipt plus detail503 preserves known plan across run change and permits GET-only recovery", async () => {
  let unavailable = true; const posts: string[] = [], gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { posts.push(String(init.body)); return json(valid); }
    gets.push(url); if (unavailable) return json({ error: "SYNTHETIC unavailable" }, 503);
    return json({ ...detail(), total: 1, plan: summary({ scopeKind: "saved_set", runID: "", sourceRunIDs: ["R1"], selectedCount: 1, state: "complete", allowedActions: [],
      counts: { waiting: 0, queued: 0, running: 0, completed: 1, held: 0, retry: 0, paused: 0, cancelled: 0 },
      admission: { admittedCount: 1, waitingCount: 0, blockedReasonCode: "", reason: "", retryAfter: null } }) });
  }));
  const controller = model(); await controller.createSavedSet(members, "pdf");
  expect(controller.state.confirmed).toEqual({ planID: id, savedSet: true }); expect(controller.state.pending).toBeNull();
  controller.changeRun("R2"); await controller.createSavedSet(members, "pdf"); await controller.retrySubmission(); expect(posts).toHaveLength(1);
  unavailable = false; await controller.read(controller.state.confirmed!.planID);
  expect(controller.state.confirmed).toBeNull(); expect(controller.state.page?.plan.planID).toBe(id); expect(posts).toHaveLength(1);
  expect(gets.every(url => url.includes(`/plans/${id}?`))).toBe(true);
});
it.each(["active", "paused", "cancelled", "complete", "partial"])("accepts contract-valid %s control and zero affected count", state => {
  expect(validateControlReceipt({ planID: id, revision: 4, state, affectedCount: 0 }, id)).toMatchObject({ state, affectedCount: 0 });
});
it("accepts a replayed positive revision and does not invent an affected-count ceiling", () => {
  const receipt = { planID: id, revision: 1, state: "partial", affectedCount: 101 };
  expect(validateControlReceipt(receipt, id)).toEqual(receipt);
});
it.each([
  {}, null, [], { planID: foreign, revision: 4, state: "paused", affectedCount: 0 },
  { planID: id, revision: 0, state: "paused", affectedCount: 0 }, { planID: id, revision: 1.5, state: "paused", affectedCount: 0 },
  { planID: id, revision: 4, state: "unknown", affectedCount: 0 }, { planID: id, revision: 4, state: "paused" },
  { planID: id, revision: 4, state: "paused", affectedCount: -1 }, { planID: id, revision: 4, state: "paused", affectedCount: 0.5 },
].map(receipt => ({ receipt })))("rejects malformed control $receipt and preserves exact explicit replay", async ({ receipt }) => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { posts.push(String(init.body)); return json(receipt); }
    return json(detail({ scopeKind: "saved_set", runID: "", sourceRunIDs: ["R1"] }));
  }));
  const controller = model(); await controller.read(id); await controller.control("pause");
  expect(controller.state.pending?.kind).toBe("control"); controller.changeRun("R2"); await controller.control("cancel");
  expect(posts).toHaveLength(1); await controller.retrySubmission(); expect(posts[1]).toBe(posts[0]);
});
it("applies exact-count validation equally to single-run create receipts", () => {
  const body = { requestID: "synthetic", runID: "R1", searchIDs: ["S"] };
  expect(validateCreateReceipt(valid, body)).toEqual(valid);
  expect(() => validateCreateReceipt({ ...valid, selectedCount: 2 }, body)).toThrow();
});
