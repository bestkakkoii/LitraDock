// SYNTHETIC transport/clock tests. Actual browser origin and Web Locks require the separate browser fixture.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { clearPubMedKey, credentialMode, providerKey, setPubMedKey } from "./credentials";
import { browserRouteSupport, minimumGap, retainSourceCooldown, withSourceSlot } from "./scheduler";
import { Descriptor, fetchPubMed, retryCooldown, validateDescriptor } from "./transport";
import { BrowserRouteController } from "./controller";
import { SearchController } from "../continuation/controller";

const run = `RUN-${"1".repeat(32)}`;
const xml = "<PubmedArticleSet>SYNTHETIC ONLY</PubmedArticleSet>";
const key = "SYNTHETIC_PERSONAL_KEY_0001";
const d = (extra: Partial<Descriptor> = {}): Descriptor => ({ runID: run, attemptID: "11111111-1111-4111-8111-111111111111", revision: 2,
  stage: "efetch", parameters: { db: "pubmed", retmode: "xml", tool: "LitraDock", id: "990000001" }, credentialMode: "unkeyed", maxBytes: 8388608,
  expiresAt: new Date(Date.now() + 120000).toISOString(), fresh: true, state: "running", ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let storage: Map<string, string>;
beforeEach(() => {
  setSession({ csrf: "SYNTHETIC_CSRF" }); storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal("isSecureContext", true);
  let tail: Promise<unknown> = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, options: { signal: AbortSignal }, callback: () => unknown) => {
    const work = tail.then(() => { options.signal.throwIfAborted(); return callback(); }); tail = work.catch(() => {}); return work;
  } } });
});
afterEach(() => { clearSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("sends the optional secret only in an official simple POST body, with no app credentials/referrer", async () => {
  setPubMedKey(key);
  let observed: { url: string; body: string; init: RequestInit } | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    observed = { url, body: String(init.body), init };
    return new Response(xml, { headers: { "Content-Type": "text/xml;charset=utf-8" } });
  }));
  expect(new TextDecoder().decode(await fetchPubMed(d({ credentialMode: "personal_key" }), new AbortController().signal))).toBe(xml);
  expect(observed?.url).toBe("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
  expect(observed?.url).not.toContain(key); expect(new URLSearchParams(observed?.body).get("api_key")).toBe(key);
  expect(observed?.init).toMatchObject({ method: "POST", credentials: "omit", mode: "cors", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
  expect(observed?.init.headers).toBeUndefined(); expect(String(observed?.init.body)).not.toContain(key);
  expect(JSON.stringify([...storage])).not.toContain(key);
  clearSession(); expect(credentialMode()).toBe("unkeyed"); expect(() => providerKey("personal_key")).toThrow("Re-enter");
});
it("missing or changed credential ownership never becomes an unkeyed retry", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(fetchPubMed(d({ credentialMode: "personal_key" }), new AbortController().signal)).rejects.toThrow("Re-enter");
  setPubMedKey(key); await expect(fetchPubMed(d(), new AbortController().signal)).rejects.toThrow("admitted without a key");
  expect(fetch).not.toHaveBeenCalled();
});
it.each([400, 401, 403])("invalid/revoked key HTTP %i has a fixed safe outcome and no fallback", async status => {
  setPubMedKey(key); const fetch = vi.fn(async () => new Response(`SYNTHETIC ${key}`, { status })); vi.stubGlobal("fetch", fetch);
  await expect(fetchPubMed(d({ credentialMode: "personal_key" }), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify([...storage])).not.toContain(key);
});
it.each(["offline", "CORS", "redirect"])("%s is an isolated unknown network outcome with no server relay", async () => {
  const fetch = vi.fn(async () => { throw new TypeError(`SYNTHETIC ${key}`); }); vi.stubGlobal("fetch", fetch);
  await expect(fetchPubMed(d(), new AbortController().signal)).rejects.toMatchObject({ code: "network_unavailable" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["unkeyed", "personal_key"] as const)("%s 429 retains readable advice through an explicit retry without saving key identity", async mode => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  if (mode === "personal_key") setPubMedKey(key);
  const fetch = vi.fn(async () => new Response("SYNTHETIC limited", { status: 429, headers: { "Retry-After": "180" } })); vi.stubGlobal("fetch", fetch);
  await expect(fetchPubMed(d({ credentialMode: mode }), new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited" });
  const saved = JSON.parse([...storage.values()][0]); expect(saved.cooldownUntil).toBe(Date.now() + 180000);
  expect(Object.keys(saved).sort()).toEqual(["cooldownUntil", "lastStart"]);
  await vi.advanceTimersByTimeAsync(61000);
  const work = vi.fn(async () => {});
  const retry = withSourceSlot(mode, new AbortController().signal, work);
  await vi.advanceTimersByTimeAsync(118999); expect(work).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await retry; expect(work).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...storage])).not.toContain(key);
  expect(retryCooldown(null)).toBe(60000); expect(retryCooldown("9999999")).toBe(86400000);
});
it("an unlocked support check cannot overwrite another tab's newer pacing state", () => {
  const name = "litradock.pubmed.pacing.v1";
  const first = JSON.stringify({ lastStart: 0, cooldownUntil: 0 });
  const newer = JSON.stringify({ lastStart: Date.now(), cooldownUntil: Date.now() + 180000 });
  storage.set(name, first);
  // Another tab commits its locked source start after our stale read.
  localStorage.getItem = (k: string) => {
    const previous = storage.get(k) ?? null;
    if (k === name) storage.set(k, newer);
    return previous;
  };
  expect(browserRouteSupport()).toBe("");
  expect(storage.get(name)).toBe(newer);
  expect([...storage.keys()]).toEqual([name]);
});
it("rejects non-XML, invalid UTF-8, oversized streams and stale or redirected descriptors", async () => {
  const inputs: [BodyInit, string][] = [["{}", "application/json"], [new Uint8Array([255]), "text/xml"], [new Uint8Array(8388609), "text/xml"]];
  for (const [body, type] of inputs) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "Content-Type": type } })));
    await expect(fetchPubMed(d(), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_response" });
  }
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(fetchPubMed(d({ fresh: false }), new AbortController().signal)).rejects.toThrow("not fresh");
  expect(() => validateDescriptor(d({ parameters: { ...d().parameters, api_key: key } }), run)).toThrow();
  expect(() => validateDescriptor(d({ parameters: { ...d().parameters, id: "990000001,990000001" } }), run)).toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("key removal aborts an active stream and cannot save the old key's response", async () => {
  setPubMedKey(key);
  vi.stubGlobal("fetch", vi.fn(async () => { clearPubMedKey(); return new Response(xml, { headers: { "Content-Type": "text/xml" } }); }));
  await expect(fetchPubMed(d({ credentialMode: "personal_key" }), new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
});
it("serializes synthetic tabs and preserves 1.2s pacing; cancelling a queued tab sends nothing", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  const starts: number[] = []; const a = new AbortController(), b = new AbortController(), c = new AbortController();
  const first = withSourceSlot("unkeyed", a.signal, async () => { starts.push(Date.now()); });
  const second = withSourceSlot("unkeyed", b.signal, async () => { starts.push(Date.now()); });
  const cancelled = withSourceSlot("unkeyed", c.signal, async () => { throw new Error("cancelled tab ran"); }).catch(e => e);
  c.abort(); await vi.runAllTimersAsync(); await Promise.all([first, second]);
  expect(starts).toHaveLength(2); expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(minimumGap);
  expect((await cancelled).name).toBe("AbortError");
  retainSourceCooldown(180000);
  await expect(withSourceSlot("unkeyed", a.signal, async () => {})).rejects.toThrow("cooling down");
});
it("fails closed when browser support or pacing storage is unavailable", async () => {
  vi.stubGlobal("navigator", {}); expect(browserRouteSupport()).toContain("Web Locks");
  const work = vi.fn(); await expect(withSourceSlot("unkeyed", new AbortController().signal, work)).rejects.toThrow(); expect(work).not.toHaveBeenCalled();
});

function page() { return { run: { run_id: run, input: "SYNTHETIC", state: "queued", total: 1, fetched: 0 }, records: [], total: 0, offset: 0, limit: 25,
  continuation: { runID: run, revision: 1, state: "queued", windowLimit: 1000, windowCount: 1, processedCount: 0, savedCount: 0, missingCount: 0,
    providerTotal: 1, pageSize: 1, attempts: 0, canContinue: false, canCancel: true, canRetry: false, reason: "SYNTHETIC", snapshotAt: "2026-09-20T00:00:00Z",
    execution: "user_browser", credentialMode: "unkeyed", canStart: true, canRecover: false } }; }
it("lost upload replays the exact app body only; it does not repeat the provider request", async () => {
  const controller = new BrowserRouteController("L1", sessionGeneration(), vi.fn()); let providerCalls = 0; const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith("https://eutils")) { providerCalls++; return new Response(xml, { headers: { "Content-Type": "text/xml" } }); }
    if (url.endsWith("/claim")) return json(d());
    if (url.endsWith("/upload")) { bodies.push(String(init.body)); if (bodies.length === 1) throw new TypeError("SYNTHETIC lost upload"); return json({ runID: run, revision: 3, state: "exhausted" }); }
    return json(page());
  }));
  await expect(controller.execute(run, new AbortController().signal)).rejects.toThrow(); expect(controller.pending?.kind).toBe("upload");
  await controller.reconcile(new AbortController().signal);
  expect(providerCalls).toBe(1); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(controller.pending).toBeNull();
  expect(bodies[0]).not.toContain(key); expect(bodies[0]).not.toContain("SYNTHETIC_CSRF");
});
it("uncertain claim reconciliation never issues a source call, even when returned fresh", async () => {
  const controller = new BrowserRouteController("L1", sessionGeneration(), vi.fn()); let claims = 0; let sources = 0; const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith("https://")) { sources++; throw new Error("no source call allowed"); }
    if (url.endsWith("/claim")) { claims++; bodies.push(String(init.body)); if (claims === 1) throw new TypeError("SYNTHETIC claim lost"); return json(d()); }
    return json(page());
  }));
  await expect(controller.execute(run, new AbortController().signal)).rejects.toThrow(); expect(controller.pending?.kind).toBe("claim");
  await controller.reconcile(new AbortController().signal); expect(sources).toBe(0); expect(bodies[0]).toBe(bodies[1]);
});
it("definite session cooldown has no pending unknown attempt and no provider traffic", async () => {
  const controller = new BrowserRouteController("L1", sessionGeneration(), vi.fn());
  const fetch = vi.fn(async (url: string) => url.endsWith("/claim") ? json({}, 429) : json(page())); vi.stubGlobal("fetch", fetch);
  await expect(controller.execute(run, new AbortController().signal)).rejects.toMatchObject({ status: 429 });
  expect(controller.pending).toBeNull(); expect(fetch.mock.calls.every(([url]) => !url.startsWith("https://"))).toBe(true);
});
it("queued browser work retains its recovery notice without a background polling loop", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => json(page())); vi.stubGlobal("fetch", fetch);
  const controller = new SearchController("L1", sessionGeneration(), vi.fn(), vi.fn(), new AbortController().signal, () => {}, () => true);
  await controller.read(run, false, "SYNTHETIC session cooldown; retry explicitly");
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1); expect(controller.state.notice).toContain("retry explicitly");
  expect(controller.state.browserRunID).toBeUndefined();controller.dispose();
});
