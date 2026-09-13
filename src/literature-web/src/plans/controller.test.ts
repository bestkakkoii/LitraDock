import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { PlanController } from "./controller";
import { detail, summary } from "./fixtures.test-support";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const models: PlanController[] = [];
function model() {
  const publish = vi.fn();
  const controller = new PlanController("library/α", "synthetic-run", sessionGeneration(), publish);
  models.push(controller);
  return { controller, publish };
}
const catalog = () => ({ plans: [summary()], total: 1, offset: 0, limit: 25 });
beforeEach(() => { setSession({ csrf: "synthetic-csrf" }); });
afterEach(() => { models.splice(0).forEach(x => x.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearSession(); });

describe("plan controller with synthetic HTTP transport", () => {
  it("replays a lost creation response with the identical UUID/body then GETs current detail", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        expect(new Headers(init.headers).get("X-CSRF")).toBe("synthetic-csrf");
        bodies.push(JSON.parse(init.body as string));
        if (bodies.length === 1) throw new TypeError("Synthetic connection lost after commit");
        return json({ planID: "PLN-00000000000000000000000000000001", revision: 1, selectedCount: 37, state: "active", affectedCount: 0 });
      }
      return json(url.includes("/PLN-00000000000000000000000000000001?") ? detail({ revision: 9, state: "partial" }) : catalog());
    });
    vi.stubGlobal("fetch", fetchMock);
    const { controller } = model();
    const ids = Array.from({ length: 37 }, (_, i) => `synthetic-${i}`);
    await controller.create(ids);
    expect(controller.state.pending?.kind).toBe("create");
    ids.push("changed-draft");
    await controller.create(ids); // An unresolved request cannot be replaced with another payload.
    expect(bodies).toHaveLength(1);
    await controller.retrySubmission();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect((bodies[0] as {searchIDs: string[]}).searchIDs).toHaveLength(37);
    expect(controller.state.page?.plan.revision).toBe(9);
    expect(controller.state.pending).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain("library%2F%CE%B1/plans");
  });

  it("reuses a control payload on lost response and refreshes after a stale-revision409 without blind retry", async () => {
    let posts = 0;
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        if (++posts === 1) throw new TypeError("Synthetic lost reply");
        return json({ error: "revision conflict" }, 409);
      }
      return json(url.includes("/PLN-00000000000000000000000000000001?") ? detail({ revision: posts ? 10 : 3 }) : catalog());
    }));
    const { controller } = model();
    await controller.read("PLN-00000000000000000000000000000001");
    await controller.control("resume");
    expect(posts).toBe(0); // Not in server allowedActions.
    await controller.control("pause");
    await controller.retrySubmission();
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({ expectedRevision: 3, value: "pause" });
    expect(controller.state.page?.plan.revision).toBe(10);
    expect(controller.state.pending).toBeNull();
    expect(controller.state.error).toContain("conflicts");
    await controller.retrySubmission();
    expect(posts).toBe(2);
  });

  it("retries only the server-authorized next group and reports the receipt subset", async () => {
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts++;
        expect(JSON.parse(String(init.body)).value).toBe("retry");
        return json({planID:"PLN-00000000000000000000000000000001",revision:4,state:"active",affectedCount:10});
      }
      return json(url.includes("/PLN-00000000000000000000000000000001?") ? detail({allowedActions:posts ? ["pause","cancel"] : ["retry","cancel"],retryEligibleCount:20}) : catalog());
    }));
    const { controller } = model();
    await controller.read("PLN-00000000000000000000000000000001");
    await controller.control("retry");
    expect(controller.state.notice).toContain("confirmed for 10 items");
    expect(controller.state.page?.plan.retryEligibleCount).toBe(20);
    await controller.control("retry");
    expect(posts).toBe(1);
  });

  it.each([200, 401])("discards a held response body (HTTP%s) after scope exit while a new controller remains usable", async status => {
    let release!: (value: string) => void;
    let bodyStarted!: () => void;
    const consumed = new Promise<void>(resolve => { bodyStarted = resolve; });
    const fetchMock = vi.fn().mockResolvedValueOnce({ status, ok: status === 200,
      text: () => { bodyStarted(); return new Promise<string>(resolve => { release = resolve; }); } });
    vi.stubGlobal("fetch", fetchMock);
    const old = model();
    const pending = old.controller.read("old");
    await consumed;
    old.controller.dispose();
    fetchMock.mockResolvedValue(json(detail({ planID: "new" })));
    const newer = model();
    await newer.controller.read("new");
    const calls = old.publish.mock.calls.length;
    const generation = sessionGeneration();
    release(JSON.stringify(status === 401 ? { error: "expired" } : detail()));
    await pending;
    expect(sessionGeneration()).toBe(generation);
    expect(old.publish.mock.calls).toHaveLength(calls);
    expect(newer.controller.state.page?.plan.planID).toBe("new");
    expect(newer.controller.state.busy).toBe(false);
  });

  it("fences an old plan response/finally during navigation without releasing newer busy ownership", async () => {
    const releases: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => releases.push(resolve))));
    const { controller } = model();
    const old = controller.read("old");
    const next = controller.read("new");
    releases[0](json(detail({ planID: "old" })));
    await old;
    expect(controller.state.busy).toBe(true);
    expect(controller.state.page).toBeNull();
    releases[1](json(detail({ planID: "new" })));
    await next;
    expect(controller.state.busy).toBe(false);
    expect(controller.state.page?.plan.planID).toBe("new");
  });

  it("polls serially after server delay, caps at120 reads and manual refresh resumes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ ...detail(), nextPollAfterMs: 5000 }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller } = model();
    await controller.read("PLN-00000000000000000000000000000001");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 119 * 5000);
    expect(fetchMock).toHaveBeenCalledTimes(121);
    expect(controller.state.pollingStopped).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fetchMock).toHaveBeenCalledTimes(121);
    await controller.read("PLN-00000000000000000000000000000001");
    expect(controller.state.automaticReads).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(123);
  });

  it("does not overlap a slow poll and stops on a read error without inferring completion", async () => {
    vi.useFakeTimers();
    let release!: (value: Response) => void;
    const fetchMock = vi.fn().mockResolvedValueOnce(json(detail()))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller } = model();
    await controller.read("PLN-00000000000000000000000000000001");
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.state.busy).toBe(true);
    release(json({error:"synthetic service failure"}, 503));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.state.page?.plan.state).toBe("active");
    expect(controller.state.error).toContain("Status unavailable");
    expect(controller.state.busy).toBe(false);
  });

  it("reopen and relogin only read; malformed counts cannot replace valid saved state", async () => {
    const fetchMock = vi.fn(async (url: string) => json(url.includes("/PLN-00000000000000000000000000000001?") ? detail() : catalog()));
    vi.stubGlobal("fetch", fetchMock);
    const first = model();
    await first.controller.catalog();
    await first.controller.read("PLN-00000000000000000000000000000001");
    first.controller.dispose();
    setSession({ csrf: "synthetic-new" });
    const second = model();
    await second.controller.catalog();
    await second.controller.read("PLN-00000000000000000000000000000001");
    expect(fetchMock.mock.calls.every(call => (call as unknown as [string, RequestInit])[1].method !== "POST")).toBe(true);
    fetchMock.mockResolvedValueOnce(json(detail({ selectedCount: 38 })));
    await second.controller.read("PLN-00000000000000000000000000000001");
    expect(second.controller.state.page?.plan.selectedCount).toBe(37);
    expect(second.controller.state.error).toContain("invalid server counts");
  });
});
