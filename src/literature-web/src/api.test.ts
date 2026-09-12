import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clearSession, setSession, sessionGeneration } from "./api";
import { canAdvanceRecords } from "./pagination";
afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});
describe("same-origin API client", () => {
  it("does not offer a next page when saved records total three but provider total is large", () => {
    expect(canAdvanceRecords(3, 0, 3)).toBe(false);
    expect(canAdvanceRecords(3298, 0, 100)).toBe(true);
  });
  it("uses stable selected IDs and request IDs for batch admission", async () => {
    setSession({ csrf: "batch-csrf" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (path, init) => new Response('{"id":"BAT-1"}', { status: 200 }),
      ),
    );
    await api.createBatch("lib", "request-1", ["search-a", "search-b"]);
    const [path, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe("/api/libraries/lib/batches");
    expect(JSON.parse(init.body)).toEqual({
      requestID: "request-1",
      searchIDs: ["search-a", "search-b"],
    });
    expect(new Headers(init.headers).get("X-CSRF")).toBe("batch-csrf");
  });
  it("does not trigger a download after session invalidation during blob consumption", async () => {
    setSession({ csrf: "blob-old" });
    let resolveBlob!: (blob: Blob) => void;
    const response = {
      status: 200,
      ok: true,
      blob: () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = resolve;
        }),
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const pending = api.original("lib", "search", "hash", sessionGeneration());
    await Promise.resolve();
    clearSession();
    resolveBlob(new Blob(["synthetic XML"]));
    await expect(pending).rejects.toThrow("Session changed");
  });
  it("sends credentials and CSRF but never persists them", async () => {
    setSession({ csrf: "csrf-test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_path, init) =>
          new Response('{"items":[]}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await api.libraries();
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-CSRF")).toBeNull();
  });
  it("sends CSRF on logout and hydrates a session CSRF value", async () => {
    setSession({ csrf: "csrf-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_path, init) =>
          new Response('{"csrf":"csrf-new"}', { status: 200 }),
      ),
    );
    await api.logout();
    const logoutInit = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(new Headers(logoutInit.headers).get("X-CSRF")).toBe("csrf-old");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response('{"csrf":"csrf-hydrated"}', { status: 200 }),
      ),
    );
    await api.session();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path, init) => new Response("{}", { status: 200 })),
    );
    await api.createLibrary("new");
    expect(
      new Headers(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers,
      ).get("X-CSRF"),
    ).toBe("csrf-hydrated");
  });
  it("rejects a delayed old body before consuming it", async () => {
    setSession({ csrf: "old" });
    let resolveResponse!: (response: Response) => void;
    const body = vi.fn(async () => '{"items":[]}');
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      ),
    );
    const pending = api.libraries();
    setSession({ csrf: "new" });
    resolveResponse({ status: 200, text: body } as unknown as Response);
    await expect(pending).rejects.toThrow("Session changed");
    expect(body).not.toHaveBeenCalled();
  });
  it("encodes library and run path segments", async () => {
    setSession({ csrf: "x" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (path) =>
          new Response('{"records":[],"run":{"state":"complete"},"total":0}', {
            status: 200,
          }),
      ),
    );
    await api.run("library/unsafe", "run?unsafe", 0);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "/library%2Funsafe/runs/run%3Funsafe?offset=0&limit=100",
    );
  });
  it("preserves the fourth generation argument while sending an optional run page size", async () => {
    setSession({ csrf: "x" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"records":[],"run":{"state":"complete"},"total":0}', { status: 200 })));
    await api.run("lib", "run", 25, sessionGeneration(), 5);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("offset=25&limit=5");
  });
  it("sends XLSX export format for exactly the selected run or batch", async () => {
    setSession({ csrf: "xlsx" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, blob: async () => new Blob(["synthetic xlsx"]) })));
    await api.exportXlsx("lib", { runID: "run-1" }, sessionGeneration());
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ runID: "run-1", format: "xlsx" });
    expect(JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).batchID).toBeUndefined();
  });
  it("discards stale generation responses", async () => {
    setSession({ csrf: "a" });
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    const pending = api.libraries();
    clearSession();
    resolve(new Response('{"items":[]}', { status: 200 }));
    await expect(pending).rejects.toThrow("Session changed");
  });
});
