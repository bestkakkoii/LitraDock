import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { StagedExportController } from "./controller";
import { context, envelope, headers, intent } from "./fixtures";
const controllers: StagedExportController[] = [];
function model() {
  const publish = vi.fn(), handoff = vi.fn(), parent = new AbortController();
  const controller = new StagedExportController("L1", context(), sessionGeneration(), parent.signal, publish, handoff);
  controllers.push(controller); return { controller, parent, publish, handoff };
}
beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.unstubAllGlobals(); clearSession(); });
it("advances only a confirmed handed-off part and never downloads the next part automatically", async () => {
  const offsets: number[] = []; let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const offset = Number(new URL(url, "https://synthetic.invalid").searchParams.get("offset")); offsets.push(offset);
    if (fail) return new Response("SYNTHETIC", { status: 503 });
    const request = intent({ offset }); return new Response(JSON.stringify(envelope(request)), { headers: headers(request) });
  }));
  const { controller, handoff } = model();
  await controller.save("json", "selected", 1000);
  expect(offsets).toEqual([0]); expect(controller.state.offset).toBe(1000); expect(controller.state.notice).toContain("1 remaining");
  fail = true; await controller.save("json", "selected", 1000);
  expect(controller.state.offset).toBe(1000); expect(handoff).toHaveBeenCalledOnce();
  fail = false; await controller.save("json", "selected", 1000);
  expect(offsets).toEqual([0, 1000, 1000]); expect(controller.state.offset).toBe(1001);
  expect(controller.state.result?.complete).toBe(false); expect(controller.state.notice).toContain("0 remaining");
  expect(handoff.mock.calls[1][1]).toContain("records-1001-1001-of-1001");
});
it.each(["cancel", "scope", "session"])("%s retirement suppresses a late response and duplicate clicks without advancing", async boundary => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
  const { controller, parent, handoff } = model(); const first = controller.save("json", "selected", 1000);
  await controller.save("json", "selected", 1000); expect(fetch).toHaveBeenCalledOnce();
  if (boundary === "cancel") controller.cancel(); else if (boundary === "scope") parent.abort(); else setSession({ csrf: "SYNTHETIC-NEW" });
  const request = intent(); resolve(new Response(JSON.stringify(envelope(request)), { headers: headers(request) })); await first;
  expect(handoff).not.toHaveBeenCalled(); expect(controller.state.offset).toBe(0);
});
it("stale revisions require explicit refresh, preserve the part position and never auto-retry", async () => {
  const fetch = vi.fn(async () => new Response("SYNTHETIC revision conflict", { status: 409 })); vi.stubGlobal("fetch", fetch);
  const { controller, handoff } = model(); await controller.save("json", "selected", 1000);
  expect(controller.state.error).toContain("Refresh both"); expect(controller.state.offset).toBe(0);
  expect(fetch).toHaveBeenCalledOnce(); expect(handoff).not.toHaveBeenCalled();
});
it("a browser handoff failure retains the exact next part", async () => {
  const request = intent(); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(envelope(request)), { headers: headers(request) })));
  const { controller, handoff } = model(); handoff.mockImplementation(() => { throw new Error("SYNTHETIC browser handoff failed"); });
  await controller.save("json", "selected", 1000); expect(controller.state.offset).toBe(0); expect(controller.state.result).toBeNull();
});
