// Isolated synthetic transport; not native serializer/provider qualification.
import { afterEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession, metadataFilename } from "./api";
import { structuredExport, type ExportScope, type StructuredFormat } from "./structuredExport";

const record = { searchId: "S-中文", identifiers: { pmid: "000123", doi: "10.123/α", pmcid: null },
  publication: { title: 'SYNTHETIC "引號"\nα', abstract: null }, originals: [] };
function data(format: StructuredFormat, scope: ExportScope, records = [record]) {
  const manifest = { schema: "litradock.research-export", schemaVersion: 1,
    type: format === "json" ? "document" : "manifest", generatedAt: "2026-09-13T00:00:00Z",
    scope: { kind: scope.runID ? "run" : "batch", runId: scope.runID ?? null, batchId: scope.batchID ?? null, selection: "all_saved_scope" },
    counts: { exportedRecords: records.length, scopeRecords: records.length, providerMatches: 25001, retrievedRecords: records.length }, queryContexts: [] };
  return format === "json" ? JSON.stringify({ ...manifest, records })
    : [JSON.stringify(manifest), ...records.map(record => JSON.stringify({ type: "record", record }))].join("\n") + "\n";
}
function response(format: StructuredFormat, scope: ExportScope) {
  return new Response(data(format, scope), { headers: { "Content-Type": format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8" } });
}
const runScope = { runID: "R-中文" };
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });

for (const format of ["json", "jsonl"] as const) {
  it.each(["empty", "duplicate", "1000", "1001"])(`${format} enforces nonempty unique1..1000 saved records: %s`, async scenario => {
    const records = scenario === "empty" ? [] : scenario === "duplicate" ? [record, record] :
      Array.from({ length: Number(scenario) }, (_, i) => ({ ...record, searchId: `SYNTHETIC-${i}` }));
    const text = data(format, runScope, records);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { headers: { "Content-Type": format === "json" ? "application/json" : "application/x-ndjson" } })));
    const pending = structuredExport("L", runScope, format, sessionGeneration(), new AbortController().signal);
    if (scenario === "1000") expect(await (await pending).blob.text()).toBe(text);
    else await expect(pending).rejects.toThrow("No file was saved");
  });
  it.each([{ runID: "R-中文" }, { batchID: "B-α" }] as ExportScope[])(`${format} exports exactly the full requested scope and preserves bytes`, async scope => {
    setSession({ csrf: "SYNTHETIC-CSRF" });
    const fetch = vi.fn(async () => response(format, scope)); vi.stubGlobal("fetch", fetch);
    const result = await structuredExport("L/中文", scope, format, sessionGeneration(), new AbortController().signal);
    const [url, init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("/api/libraries/L%2F%E4%B8%AD%E6%96%87/exports");
    expect(JSON.parse(String(init.body))).toEqual({ ...scope, format });
    expect(init.method).toBe("POST"); expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-CSRF")).toBe("SYNTHETIC-CSRF");
    expect(await result.blob.text()).toBe(data(format, scope));
    expect(result.filename).toBe(metadataFilename(scope, format));
  });
  it.each(["wrong media", "error envelope", "foreign scope", "truncated", "wrong count", "invalid UTF8"])(`${format} rejects %s rather than producing a file`, async failure => {
    setSession({ csrf: "SYNTHETIC" });
    let bytes: BodyInit = data(format, runScope), media = format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8";
    if (failure === "wrong media") media = "text/html";
    if (failure === "error envelope") bytes = '{"error":"SYNTHETIC denial"}';
    if (failure === "foreign scope") bytes = data(format, { runID: "FOREIGN" });
    if (failure === "truncated") bytes = String(bytes).slice(0, -1);
    if (failure === "wrong count") bytes = String(bytes).replace('"exportedRecords":1', '"exportedRecords":2');
    if (failure === "invalid UTF8") bytes = new Uint8Array([255]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "Content-Type": media } })));
    await expect(structuredExport("L", runScope, format, sessionGeneration(), new AbortController().signal)).rejects.toThrow("No file was saved");
  });
}

it("accepts a browser-normalized media essence while still validating actual UTF8", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(data("json", runScope), { headers: { "Content-Type": "application/json" } })));
  expect((await structuredExport("L", runScope, "json", sessionGeneration(), new AbortController().signal)).filename).toBe("litradock-saved-R-中文.json");
});

it.each([{}, { runID: "R", batchID: "B" }, { runID: "" }])("rejects ambiguous/missing scope before HTTP", async scope => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(structuredExport("L", scope as ExportScope, "json", sessionGeneration(), new AbortController().signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

for (const status of [200, 401, 503]) {
  it.each(["scope", "session"])(`held HTTP ${status} body discarded on %s change; newer positive control remains usable`, async change => {
    setSession({ csrf: "SYNTHETIC-A" });
    const generation = sessionGeneration(), abort = new AbortController();
    let release!: (value: Blob | string) => void, started!: () => void;
    const consuming = new Promise<void>(resolve => { started = resolve; });
    const consume = () => { started(); return new Promise<Blob | string>(resolve => { release = resolve; }); };
    vi.stubGlobal("fetch", vi.fn(async () => ({ status, ok: status === 200, blob: consume, text: consume })));
    const old = structuredExport("L", runScope, "json", generation, abort.signal);
    await consuming;
    if (change === "scope") abort.abort(); else setSession({ csrf: "SYNTHETIC-B" });
    const newer = sessionGeneration();
    release(status === 200 ? await response("json", runScope).blob() : '{"error":"old failure"}');
    await expect(old).rejects.toThrow("Session changed");
    expect(sessionGeneration()).toBe(newer);
    vi.stubGlobal("fetch", vi.fn(async () => response("jsonl", { batchID: "NEW" })));
    expect((await structuredExport("L2", { batchID: "NEW" }, "jsonl", newer, new AbortController().signal)).filename).toBe("batch-NEW.jsonl");
  });
}

it("rechecks identity after the additional UTF8 validation read", async () => {
  setSession({ csrf: "SYNTHETIC-A" });
  const blob = await response("json", runScope).blob();
  const bytes = await blob.arrayBuffer();
  let release!: (value: ArrayBuffer) => void, started!: () => void;
  const consuming = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(blob, "arrayBuffer").mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, blob: async () => blob })));
  const old = structuredExport("L", runScope, "json", sessionGeneration(), new AbortController().signal);
  await consuming; setSession({ csrf: "SYNTHETIC-B" }); release(bytes);
  await expect(old).rejects.toThrow("context changed");
});

it("a current401 expires the session; a current503 is not a file", async () => {
  setSession({ csrf: "SYNTHETIC" }); const before = sessionGeneration();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"expired"}', { status: 401 })));
  await expect(structuredExport("L", runScope, "json", before, new AbortController().signal)).rejects.toThrow("expired");
  expect(sessionGeneration()).toBe(before + 1);
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 })));
  await expect(structuredExport("L", runScope, "json", sessionGeneration(), new AbortController().signal)).rejects.toThrow("HTTP 503");
});

for (const format of ["json", "jsonl"] as const) {
  it.each(["valid", "header scope", "header revision", "header count", "IDs", "revision", "saved count"])(`${format} selected snapshot validates exact membership and headers: %s`, async fault => {
    const scope = { runID: "R-中文", selection: "selected" as const, selectionRevision: 7, selectedIDs: [record.searchId], savedCount: 1000 };
    let text = data(format, runScope).replace('"selection":"all_saved_scope"', '"selection":"selected_saved_records","selectionRevision":7,"savedRecords":1000');
    if (fault === "IDs") text = text.replace(record.searchId, "WRONG");
    if (fault === "revision") text = text.replace('"selectionRevision":7', '"selectionRevision":8');
    if (fault === "saved count") text = text.replace('"savedRecords":1000', '"savedRecords":1');
    const headers = { "Content-Type": format === "json" ? "application/json" : "application/x-ndjson",
      "X-LitraDock-Export-Scope": fault === "header scope" ? "all_saved_scope" : "selected_saved_records",
      "X-LitraDock-Selection-Revision": fault === "header revision" ? "8" : "7",
      "X-LitraDock-Export-Count": fault === "header count" ? "2" : "1" };
    const fetch = vi.fn(async () => new Response(text, { headers })); vi.stubGlobal("fetch", fetch);
    const pending = structuredExport("L", scope, format, sessionGeneration(), new AbortController().signal);
    if (fault === "valid") {
      const result = await pending; expect(await result.blob.text()).toBe(text);
      expect(result.filename).toBe(`litradock-selected-R-中文-r7.${format}`);
      expect(JSON.parse(String((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body)))
        .toEqual({ RunID: "R-中文", Selection: "selected", SelectionRevision: 7, Format: format });
    } else await expect(pending).rejects.toThrow("No file was saved");
  });
}
