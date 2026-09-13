import { afterEach, expect, it, vi } from "vitest";
import { api, clearSession, sessionGeneration, setSession } from "../api";

afterEach(() => { vi.unstubAllGlobals(); clearSession(); });
const methods = {
  original: (signal: AbortSignal) => api.original("synthetic-library", "synthetic-search", "a".repeat(64), sessionGeneration(), signal),
  csv: (signal: AbortSignal) => api.exportCsv("synthetic-library", { batchID: "synthetic-batch" }, sessionGeneration(), signal),
  xlsx: (signal: AbortSignal) => api.exportXlsx("synthetic-library", { runID: "synthetic-run" }, sessionGeneration(), signal),
  zip: (signal: AbortSignal) => api.exportBundle("synthetic-library", "synthetic-batch", sessionGeneration(), signal),
};
for (const [name, download] of Object.entries(methods)) {
  it.each([200, 401])(`${name} discards held body HTTP%s after plan navigation without expiring the current session`, async status => {
    setSession({csrf:"SYNTHETIC"});
    const generation = sessionGeneration();
    const abort = new AbortController();
    let release!: (body: Blob | string) => void;
    let started!: () => void;
    const consuming = new Promise<void>(resolve => { started = resolve; });
    const consume = () => { started(); return new Promise<Blob | string>(resolve => { release = resolve; }); };
    vi.stubGlobal("fetch", vi.fn(async () => ({status,ok:status===200,blob:consume,text:consume})));
    const pending = download(abort.signal);
    await consuming;
    abort.abort();
    release(status === 200 ? new Blob(["SYNTHETIC file bytes"]) : "SYNTHETIC expired");
    await expect(pending).rejects.toThrow("Session changed");
    expect(sessionGeneration()).toBe(generation);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SYNTHETIC current file")));
    expect(await (await download(new AbortController().signal)).text()).toBe("SYNTHETIC current file");
  });
}
it("a current401 still invalidates the session after reading its body", async () => {
  setSession({csrf:"SYNTHETIC"});
  const generation = sessionGeneration();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"expired"}',{status:401})));
  await expect(api.exportBundle("library","batch",generation,new AbortController().signal)).rejects.toThrow("expired");
  expect(sessionGeneration()).toBe(generation+1);
});
