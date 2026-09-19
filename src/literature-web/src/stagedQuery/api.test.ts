// Contract fixtures only: no network/provider or real archive-capacity evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { downloadExport, exportCounts, exportFilename, validateZip } from "./api";
import { context, envelope, headers, intent } from "./fixtures";

beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { clearSession(); vi.unstubAllGlobals(); });
it.each(["json", "jsonl"] as const)("preserves exact %s part bytes, selected ordering and final-part identity", async format => {
  const request = intent({ format, offset: 1000 });
  const value = envelope(request);
  const { records, ...manifest } = value;
  const body = format === "json" ? JSON.stringify(value) : [manifest, ...records!].map(v => JSON.stringify(v)).join("\n") + "\n";
  const fetch = vi.fn(async () => new Response(body, { headers: headers(request, format === "json" ? "application/json" : "application/x-ndjson") }));
  vi.stubGlobal("fetch", fetch);
  const result = await downloadExport("L/1", request, sessionGeneration(), new AbortController().signal);
  expect(await result.blob.text()).toBe(body);
  expect(result).toMatchObject({ count: 1, scopeCount: 1001, offset: 1000, remaining: 0, complete: false });
  expect(result.filename).toContain("records-1001-1001-of-1001");
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toContain("/api/libraries/L%2F1/runs/");
  expect(path).toContain("revision=12&captureRevision=7&offset=1000&limit=1000");
  expect(init.method).toBeUndefined(); expect(init.body).toBeUndefined();
});
it.each(["X-LitraDock-Selection-Revision", "X-LitraDock-Capture-Revision", "X-LitraDock-Export-Count", "X-LitraDock-Scope-Count",
  "X-LitraDock-Export-Offset", "X-LitraDock-Export-Remaining"])("rejects missing or changed %s before reading a body", async name => {
  const request = intent();
  for (const value of [null, "-1", "1.5", "999999"]) {
    const h = headers(request); if (value === null) h.delete(name); else h.set(name, value);
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: h })));
    await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow("scope");
    expect(cancel).toHaveBeenCalledOnce();
  }
});
it.each([{ scope: "all" }, { selectionRevision: 13 }, { captureRevision: 8 }, { offset: 1 }, { scopeCount: 1000 }, { count: 999 },
  { remaining: 0 }, { complete: true }, { runId: `RUN-${"2".repeat(32)}` }, { originalQuery: "changed query" }, { records: [] }])
  ("refuses mismatched structured metadata %j", async patch => {
    const request = intent();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...envelope(request), ...patch }), { headers: headers(request) })));
    await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  });
it("rejects substituted or reordered selection members even when count headers match", async () => {
  const request = intent();
  for (const replacement of ["FOREIGN", "SYNTHETIC-2"]) {
    const document = envelope(request); document.records![0].searchId = replacement;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(document), { headers: headers(request) })));
    await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  }
});
it("exports all captured IDs with distinct saved, missing and pending states without claiming metadata completeness", async () => {
  const request = intent({ format: "manifest", scope: "all" });
  const document = envelope(request);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(document), { headers: headers(request) })));
  const result = await downloadExport("L", request, sessionGeneration(), new AbortController().signal);
  expect(result).toMatchObject({ scopeCount: 1003, count: 1003, offset: 0, remaining: 0, complete: true });
  expect(result.filename).toContain("captured-ids");
  expect(document.savedCount).toBe(1001); expect(document.missingCount).toBe(1);
  document.capturedIdentities![1002].metadataState = "saved";
  await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow();
});
it.each(["csv", "xlsx", "json", "jsonl"] as const)("whole %s ZIP represents all 20000 saved members in one response", format => {
  const request = intent({ format: `zip-${format}`, context: context({ savedCount: 20000, capturedCount: 20000, processedCount: 20000,
    missingCount: 0, selectedIDs: Array.from({ length: 20000 }, (_, i) => `S${i}`) }) });
  expect(exportCounts(request)).toEqual({ count: 20000, scopeCount: 20000, offset: 0, remaining: 0, complete: true });
  expect(exportFilename(request, exportCounts(request))).toContain(`${format}.zip`);
  expect(() => exportCounts({ ...request, offset: 1000 })).toThrow();
});
it.each([0, 1001, -1, 0.5])("rejects unsupported part size %i without any request", async limit => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(downloadExport("L", intent({ limit }), sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("bounds response bytes, rejects partial ZIP or wrong media, and prevents retired-session downloads", async () => {
  const request = intent({ format: "zip-json" });
  const h = headers(request, "application/zip"); h.set("Content-Length", String(64 * 1024 * 1024 + 1));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("SYNTHETIC", { headers: h })));
  await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow("byte limit");
  expect(() => validateZip(new Uint8Array([80, 75, 3, 4]))).toThrow();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>SYNTHETIC error</html>", { headers: headers(request, "text/html") })));
  await expect(downloadExport("L", request, sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  const generation = sessionGeneration(); setSession({ csrf: "SYNTHETIC-NEXT" }); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(downloadExport("L", request, generation, new AbortController().signal)).rejects.toThrow("context changed");
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves a complete standard ZIP's bytes and rejects truncation with the same headers", async () => {
  // .NET ZipArchive-produced fixture, not evidence of archive record/cell counts.
  const bytes = Uint8Array.from(atob("UEsDBBQAAAAIAGYlNF0odbvAMgAAACoAAAAOAAAAc3ludGhldGljLmpzb26qVgqO9AvxcA3xdFayUoryDFAoKUrMKy7ILypRSMusKCktSlXIz8upVKoFAAAA//8DAFBLAQIUABQAAAAIAGYlNF0odbvAMgAAACoAAAAOAAAAAAAAAAAAAAAAAAAAAABzeW50aGV0aWMuanNvblBLBQYAAAAAAQABADwAAABeAAAAAAA="), c => c.charCodeAt(0));
  const request = intent({ format: "zip-json", context: context({ savedCount: 1, selectedIDs: ["S1"], capturedCount: 1, processedCount: 1, missingCount: 0 }) });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: headers(request, "application/zip") })));
  const result = await downloadExport("L", request, sessionGeneration(), new AbortController().signal);
  expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes); expect(result.remaining).toBe(0);
  expect(() => validateZip(bytes.slice(0, -1))).toThrow();
});
