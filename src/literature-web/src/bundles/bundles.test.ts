// SYNTHETIC controlled transport only; no native handler or provider calls.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { BundleController } from "./controller";
import { fixtureDocument, fixturePlan } from "./fixtures";
import { validateDocument, validateList } from "./model";
import { PartTransfer } from "./transfer";
const bytes = new TextEncoder().encode("SYNTHETIC ZIP bytes for transport tests only");
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
const doc = () => fixtureDocument([{ bytes: 5, sha256: "b".repeat(64), zipBytes: bytes.length, zipHash: hash }]);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const heads = (start = 0) => ({ "Content-Type": "application/zip", ETag: `"${hash}"`, "Accept-Ranges": "bytes", "Content-Length": String(bytes.length - start),
  ...(start ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
function held(status = 200, headers: Record<string, string> = {}) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { feed = c; }, cancel() { cancelled = true; } }), { status, headers });
  return { response, feed, get cancelled() { return cancelled; } };
}
const models: BundleController[] = [];
function model() {
  const publish = vi.fn(), save = vi.fn(), c = new BundleController("SYNTHETIC-L", fixturePlan, sessionGeneration(), publish, save);
  models.push(c); return { c, publish, save };
}
beforeEach(() => setSession({ csrf: "SYNTHETIC" }));
afterEach(() => { models.splice(0).forEach(c => c.dispose()); clearSession(); vi.unstubAllGlobals(); });
it("validates complete ordered membership, exact dedup aliases, and useful unavailable-only snapshots", () => {
  expect(validateDocument(doc(), fixturePlan).parts).toHaveLength(1);
  expect(validateDocument(fixtureDocument(), fixturePlan).manifest.counts.unresolvedRecords).toBe(3);
  const d = doc(); const item = { ...d.manifest.items[0], searchId: "SYNTHETIC-S1", rank: 2 };
  d.manifest.items[1] = item; d.parts[0].files[0].searchIDs.push(item.searchId);
  d.manifest.counts.includedRecords = 2; d.manifest.counts.unresolvedRecords = 1;
  expect(validateDocument(d, fixturePlan).parts[0].files).toHaveLength(1);
});
it.each(["zero", "duplicate", "foreign", "path", "count", "association", "hash", "bytes"])("rejects malformed %s snapshot before receipt commitment", bad => {
  const d = doc();
  if (bad === "zero") d.manifest.counts.members = 0;
  if (bad === "duplicate") d.manifest.items[1].searchId = d.manifest.items[0].searchId;
  if (bad === "foreign") d.planID = "foreign";
  if (bad === "path") d.parts[0].filename = "../foreign.zip";
  if (bad === "count") d.manifest.counts.includedRecords++;
  if (bad === "association") d.parts[0].files[0].searchIDs = ["foreign"];
  if (bad === "hash") d.parts[0].sha256 = "not a hash";
  if (bad === "bytes") d.parts[0].bytes = 18 * 1024 * 1024;
  expect(() => validateDocument(d, fixturePlan)).toThrow();
});
it("requires bounded unique summary list and correct complete count", () => {
  expect(validateList({ items: [], total: 0 }, fixturePlan.planID)).toEqual([]);
  expect(() => validateList({ items: [], total: 1 }, fixturePlan.planID)).toThrow();
  expect(() => validateList({ items: Array(21).fill({}), total: 21 }, fixturePlan.planID)).toThrow();
});
it.each(["shape", "invalidJSON", "lost", "503"])("preserves exact preparation UUID/body after %s and GET-only navigation", async mode => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/service-info") return json({ bundleDeliveryEnabled: true });
    if (init.method === "POST") {
      posts.push(String(init.body));
      if (posts.length > 1) return json(doc());
      if (mode === "lost") throw new TypeError("SYNTHETIC lost response");
      return mode === "invalidJSON" ? new Response("{") : json(mode === "shape" ? {} : { error: "SYNTHETIC unavailable" }, mode === "503" ? 503 : 200);
    }
    return url.endsWith("/bundles") ? json({ items: [], total: 0 }) : json(doc());
  }));
  const { c } = model(); await c.initialize(); await c.prepare();
  expect(c.state.pending).toBe(true); await c.open(doc().snapshotID); c.select([]); await c.refresh();
  expect(posts).toHaveLength(1); await c.prepare(); expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]);
  expect(Object.keys(JSON.parse(posts[0]))).toEqual(["requestID"]); expect(c.state.pending).toBe(false);
});
it("confirmed receipt plus failed detail GET retains known snapshot and supports GET-only reopen", async () => {
  let fail = true; const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/service-info") return json({ bundleDeliveryEnabled: true });
    if (init.method === "POST") { posts.push(String(init.body)); return json(doc()); }
    if (url.endsWith("/bundles")) return json({ items: [], total: 0 });
    return fail ? json({}, 503) : json(doc());
  }));
  const { c, save } = model(); await c.initialize(); await c.prepare();
  expect(c.state.pending).toBe(false); expect(c.state.document?.snapshotID).toBe(doc().snapshotID); expect(c.hasManifest).toBe(false);
  c.saveManifest(); expect(save).not.toHaveBeenCalled(); fail = false; await c.open(doc().snapshotID); c.saveManifest();
  expect(posts).toHaveLength(1); expect(await (save.mock.calls[0][0] as Blob).text()).toBe(JSON.stringify(doc()));
});
it("policy denial never prepares but retained snapshots remain GET-only", async () => {
  const fetcher = vi.fn(async (url: string) => url === "/service-info" ? json({ bundleDeliveryEnabled: false }) : url.endsWith("/bundles") ? json({ items: [], total: 0 }) : json(doc()));
  vi.stubGlobal("fetch", fetcher); const { c } = model(); await c.initialize(); await c.prepare(); await c.open(doc().snapshotID);
  expect(fetcher.mock.calls.every(call => !String(call[0]).includes("acquisition"))).toBe(true); expect(c.state.document).not.toBeNull();
});
it("streams actual bytes, resumes only exact bounded range, then verifies complete hash", async () => {
  const transfer = new PartTransfer(), part = doc().parts[0], progress = vi.fn();
  const first = held(200, heads()); const fetcher = vi.fn().mockResolvedValueOnce(first.response);
  vi.stubGlobal("fetch", fetcher);
  const pending = transfer.read("/synthetic/part", part, new AbortController().signal, sessionGeneration(), () => true, progress);
  first.feed.enqueue(bytes.slice(0, 9)); await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith({ received: 9, total: bytes.length, state: "receiving" }));
  first.feed.close(); await expect(pending).rejects.toThrow("ended early"); expect(transfer.retainedBytes).toBe(9);
  fetcher.mockResolvedValueOnce(new Response(bytes.slice(9), { status: 206, headers: heads(9) }));
  const blob = await transfer.read("/synthetic/part", part, new AbortController().signal, sessionGeneration(), () => true, progress);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  const headers = fetcher.mock.calls[1][1].headers as Headers;
  expect(headers.get("Range")).toBe(`bytes=9-${bytes.length - 1}`); expect(headers.get("If-Match")).toBe(`"${hash}"`);
  expect(transfer.retainedBytes).toBe(0);
});
it.each(["etag", "range", "length", "encoding", "hash", "oversize"])("discards unsafe %s bytes without producing a Blob", async bad => {
  const transfer = new PartTransfer(), part = doc().parts[0], headers: Record<string, string> = heads();
  if (bad === "etag") headers.ETag = hash;
  if (bad === "range") headers["Content-Range"] = `bytes 0-${bytes.length - 1}/${bytes.length}`;
  if (bad === "length") headers["Content-Length"] = "999";
  if (bad === "encoding") headers["Content-Encoding"] = "gzip";
  const body = bytes.slice(); if (bad === "hash") body[0] ^= 1;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bad === "oversize" ? new Uint8Array(bytes.length + 1) : body, { headers })));
  await expect(transfer.read("/synthetic", part, new AbortController().signal, sessionGeneration(), () => true, vi.fn())).rejects.toThrow("integrity");
  expect(transfer.retainedBytes).toBe(0);
});
it.each([200, 401, 503])("held old %i body cannot publish or expire newer body-pending or published scope", async status => {
  for (const order of ["pending", "published"]) {
    const old = held(status, status === 200 ? { "Content-Type": "application/json" } : {}), newer = held(200, { "Content-Type": "application/json" });
    const fetcher = vi.fn().mockResolvedValueOnce(old.response).mockResolvedValueOnce(newer.response);
    vi.stubGlobal("fetch", fetcher); const { c, publish, save } = model();
    const first = c.open(doc().snapshotID); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = c.open(doc().snapshotID); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    if (order === "published") { newer.feed.enqueue(new TextEncoder().encode(JSON.stringify(doc()))); newer.feed.close(); await second; }
    const calls = publish.mock.calls.length, generation = sessionGeneration();
    // Successful blob reads actively cancel obsolete streams. Error-body reads
    // remain held until release, exercising the independent after-body fence.
    if (!old.cancelled) { old.feed.enqueue(new TextEncoder().encode(JSON.stringify(status === 200 ? doc() : {}))); old.feed.close(); }
    else expect(status).toBe(200);
    await first;
    expect(publish).toHaveBeenCalledTimes(calls); expect(sessionGeneration()).toBe(generation); expect(save).not.toHaveBeenCalled();
    if (order === "pending") { expect(c.state.busy).not.toBe(""); newer.feed.enqueue(new TextEncoder().encode(JSON.stringify(doc()))); newer.feed.close(); await second; }
    expect(c.state.busy).toBe(""); expect(c.state.document).not.toBeNull();
  }
});
it.each([200, 401, 503])("old part %i chunks cannot save or clear current account; same-scope401 still denies", async status => {
  const h = held(status, status === 200 ? heads() : {}); vi.stubGlobal("fetch", vi.fn(async () => h.response));
  const transfer = new PartTransfer(), progress = vi.fn(), abort = new AbortController();
  const result = transfer.read("/synthetic", doc().parts[0], abort.signal, sessionGeneration(), () => !abort.signal.aborted, progress);
  await Promise.resolve(); await Promise.resolve(); const count = progress.mock.calls.length;
  abort.abort(); setSession({ csrf: "B" }); const g = sessionGeneration();
  h.feed.enqueue(bytes); h.feed.close(); await expect(result).rejects.toThrow("context changed");
  expect(progress).toHaveBeenCalledTimes(count); expect(sessionGeneration()).toBe(g);
  vi.stubGlobal("fetch", vi.fn(async () => json({}, 401)));
  await expect(new PartTransfer().read("/synthetic", doc().parts[0], new AbortController().signal, g, () => true, vi.fn())).rejects.toThrow("expired");
  expect(sessionGeneration()).toBe(g + 1);
});
it.each([200, 401, 503])("old part %i cannot disturb newer transfer before or after its body publishes", async status => {
  for (const order of ["pending", "published"]) {
    const old = held(status, status === 200 ? heads() : {}), newer = held(200, heads());
    const partReplies = [old.response, newer.response];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/parts/") ? partReplies.shift()! : json(doc())));
    const { c, publish, save } = model(); await c.open(doc().snapshotID);
    const first = c.download([1]); await vi.waitFor(() => expect(partReplies).toHaveLength(1));
    await c.open(doc().snapshotID); const second = c.download([1]); await vi.waitFor(() => expect(partReplies).toHaveLength(0));
    if (order === "published") { newer.feed.enqueue(bytes); newer.feed.close(); await second; }
    const calls = publish.mock.calls.length, generation = sessionGeneration();
    old.feed.enqueue(status === 200 ? bytes : new TextEncoder().encode("{}")); old.feed.close(); await first;
    expect(publish).toHaveBeenCalledTimes(calls); expect(sessionGeneration()).toBe(generation);
    if (order === "pending") { expect(c.state.busy).not.toBe(""); expect(save).not.toHaveBeenCalled(); newer.feed.enqueue(bytes); newer.feed.close(); await second; }
    expect(save).toHaveBeenCalledTimes(1); expect(c.state.busy).toBe("");
  }
});
it("failed first part pauses selected queue; cancellation/reopen discards old partial memory", async () => {
  const d = doc(); d.parts.push({ ...d.parts[0], number: 2, filename: "part-002.zip", files: [{ ...d.parts[0].files[0], sha256: "c".repeat(64), file: `originals/${"c".repeat(64)}.xml`, searchIDs: ["SYNTHETIC-S1"] }] });
  d.manifest.items[1] = { ...d.manifest.items[0], searchId: "SYNTHETIC-S1", rank: 2, file: d.parts[1].files[0].file, original: { ...d.manifest.items[0].original!, sha256: "c".repeat(64) } };
  d.manifest.counts = { members: 3, includedRecords: 2, unresolvedRecords: 1, uniqueOriginals: 2, originalBytes: 10 };
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { paths.push(url); return url.includes("/parts/") ? json({}, 503) : json(d); }));
  const { c, save } = model(); await c.open(d.snapshotID); await c.download(c.state.selected);
  expect(paths.filter(p => p.includes("/parts/"))).toHaveLength(1); expect(save).not.toHaveBeenCalled(); expect(c.state.busy).toBe("");
});
