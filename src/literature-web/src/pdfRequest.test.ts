import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "./api";
import { PdfRequest } from "./pdfRequest";
import { originalKind } from "./originalKind";

beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });
it.each([1, 10, 11, 100])("%i IDs admit exactly one format-bound request to the correct route", async count => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(count <= 10 ? { id: "B1" } : { planID: "P1" }));
  }));
  const request = new PdfRequest("L1", "R1", Array.from({ length: count }, (_, i) => `SYNTHETIC-${i}`), sessionGeneration(), true);
  await request.send(new AbortController().signal);
  expect(calls).toHaveLength(1); expect(calls[0].url).toMatch(count <= 10 ? /batches$/ : /plans$/);
  expect(calls[0].body).toEqual({ ...request.body });
  expect(calls[0].body.format).toBe("pdf");
});
it("rejects zero,101,duplicates and plan-disabled admission before HTTP", () => {
  for (const ids of [[], Array.from({ length: 101 }, (_, i) => String(i)), ["x", "x"]])
    expect(() => new PdfRequest("L1", "R1", ids, sessionGeneration(), true)).toThrow();
  expect(() => new PdfRequest("L1", "R1", Array.from({ length: 11 }, (_, i) => String(i)), sessionGeneration(), false)).toThrow();
});
it.each([1, 11])("uncertain retries of %i IDs keep UUID, IDs and format; confirmed receipt never repeats POST", async count => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body)); if (bodies.length === 1) throw new Error("SYNTHETIC lost reply");
    return new Response(JSON.stringify({ id: "B1", planID: "P1" }));
  }));
  const ids = Array.from({ length: count }, (_, i) => `SYNTHETIC-${i}`), snapshot = [...ids], request = new PdfRequest("L1", "R1", ids, sessionGeneration(), true);
  ids.push("changed-draft");
  await expect(request.send(new AbortController().signal)).rejects.toThrow();
  await request.send(new AbortController().signal); await request.send(new AbortController().signal);
  expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(request.body.searchIDs).toEqual(snapshot);
});
it("aborted old body cannot return a navigation target", async () => {
  let release!: (body: string) => void;
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, text: () => new Promise<string>(resolve => { release = resolve; }) })));
  const signal = new AbortController(), request = new PdfRequest("L1", "R1", ["x"], sessionGeneration(), true);
  const pending = request.send(signal.signal);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); signal.abort(); release('{"id":"OLD"}');
  await expect(pending).rejects.toThrow();
});
it("uses actual acquired format/media, never requested format, and preserves XML", () => {
  const original = { original_hash: "abc", downloadAvailable: true };
  expect(originalKind({ ...original, format: "PDF", mediaType: "application/pdf" })).toBe("pdf");
  expect(originalKind({ ...original, format: "PDF", mediaType: "text/html" })).toBeNull();
  expect(originalKind({ ...original, format: "", mediaType: "", downloadAvailable: false })).toBeNull();
  expect(originalKind({ ...original, format: "XML" })).toBe("xml");
});
