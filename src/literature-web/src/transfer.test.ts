import { afterEach, expect, it, vi } from "vitest";
import { clearSession, requestBlob, sessionGeneration, setSession } from "./api";
import { readTransfer, TransferProgress } from "./transfer";
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });

function stream(headers: Record<string, string> = {}) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(controller) { feed = controller; } }), { headers });
  return { response, feed };
}
it.each([undefined, "gzip", "identity"])("reports actual paced bytes with comparable length only for encoding %s", async encoding => {
  const { response, feed } = stream({ "Content-Length": "6", ...(encoding ? { "Content-Encoding": encoding } : {}) });
  const progress: TransferProgress[] = [];
  const result = readTransfer(response, null, () => {}, { onProgress: value => progress.push(value) });
  feed.enqueue(new Uint8Array([1, 2])); await Promise.resolve(); await Promise.resolve();
  expect(progress.at(-1)).toEqual({ received: 2, total: encoding === "gzip" ? undefined : 6 });
  feed.enqueue(new Uint8Array([3, 4, 5, 6])); feed.close();
  expect(new Uint8Array(await (await result).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  expect(progress.at(-1)?.received).toBe(6);
});
it("unknown length stays bytes-only and byte ceiling rejects the stream rather than saving a prefix", async () => {
  const { response, feed } = stream(); const progress: TransferProgress[] = [];
  const result = readTransfer(response, null, () => {}, { maxBytes: 3, onProgress: value => progress.push(value) });
  feed.enqueue(new Uint8Array([1, 2])); await Promise.resolve(); await Promise.resolve();
  expect(progress.at(-1)).toEqual({ received: 2, total: undefined });
  feed.enqueue(new Uint8Array([3, 4]));
  await expect(result).rejects.toThrow("byte limit");
});
it("rejects declared-length mismatch and transport failure without returning partial files", async () => {
  await expect(readTransfer(new Response("ab", { headers: { "Content-Length": "4" } }), null, () => {})).rejects.toThrow("Incomplete");
  const { response, feed } = stream(); const result = readTransfer(response, null, () => {});
  feed.enqueue(new Uint8Array([1])); feed.error(new Error("SYNTHETIC broken stream"));
  await expect(result).rejects.toThrow("broken stream");
});
it.each(["library", "account"])("held stream retires %s and cannot publish progress or affect a newer positive operation", async scope => {
  setSession({ csrf: "A" }); const generation = sessionGeneration(), abort = new AbortController();
  const { response, feed } = stream(); vi.stubGlobal("fetch", vi.fn(async () => response));
  const progress = vi.fn(); const result = requestBlob("/synthetic", { signal: abort.signal }, generation, { onProgress: progress });
  await Promise.resolve(); await Promise.resolve();
  const before = progress.mock.calls.length;
  if (scope === "account") { setSession({ csrf: "B" }); feed.enqueue(new Uint8Array([1])); } else abort.abort();
  await expect(result).rejects.toThrow("Session changed"); expect(progress).toHaveBeenCalledTimes(before);
  const newer = sessionGeneration(); vi.stubGlobal("fetch", vi.fn(async () => new Response("SYNTHETIC current")));
  expect(await (await requestBlob("/synthetic-current", {}, newer)).text()).toBe("SYNTHETIC current");
  expect(sessionGeneration()).toBe(newer);
});
