import { ApiError, clearSession, sessionGeneration } from "../api";
import { BundlePart, MiB } from "./model";

export type PartProgress = { received: number; total: number; state: "receiving" | "verifying" | "paused" | "ready" };
class InvalidTransfer extends Error {}
const invalid = () => new InvalidTransfer("Part integrity or range headers did not match. Partial bytes were discarded; retry from the beginning.");

// One retained partial per workspace; never persisted in storage. Bytes are
// tentative until the final whole-ZIP SHA256 succeeds, and cannot be saved early.
export class PartTransfer {
  private key = "";
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private received = 0;
  discard() { this.key = ""; this.chunks = []; this.received = 0; }
  get retainedBytes() { return this.received; }
  async read(path: string, part: BundlePart, signal: AbortSignal, generation: number,
    current: () => boolean, progress: (value: PartProgress) => void): Promise<Blob> {
    const check = () => { if (!current() || signal.aborted || generation !== sessionGeneration()) throw new Error("Download context changed."); };
    check();
    const key = `${path}|${part.sha256}|${part.bytes}`;
    if (key !== this.key) { this.discard(); this.key = key; }
    const start = this.received, remaining = part.bytes - start;
    if (remaining < 1 || part.bytes > 17 * MiB) { this.discard(); throw invalid(); }
    const headers = new Headers();
    if (start) { headers.set("Range", `bytes=${start}-${part.bytes - 1}`); headers.set("If-Match", `"${part.sha256}"`); }
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    try {
      const response = await fetch(path, { credentials: "same-origin", redirect: "error", signal, headers });
      check();
      if (!response.ok) {
        // Consume bounded error bytes before any authentication effect. A held
        // obsolete error body must not invalidate the next library or account.
        reader = response.body?.getReader();
        let size = 0;
        if (reader) for (;;) {
          const chunk = await reader.read(); check();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 64 * 1024) { await reader.cancel(); check(); break; }
        }
        check();
        if (response.status === 401) { clearSession(); throw new ApiError(401, "Your session has expired. Please sign in again."); }
        if ([409, 410, 412, 416].includes(response.status)) this.discard();
        const retry = response.headers.get("Retry-After");
        throw new ApiError(response.status, `Part unavailable (HTTP ${response.status}).`, retry && /^\d+$/.test(retry) && Number(retry) <= 86400 ? Number(retry) : undefined);
      }
      const h = response.headers;
      if (response.status !== (start ? 206 : 200) || h.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/zip" ||
          h.get("ETag") !== `"${part.sha256}"` || h.get("Accept-Ranges") !== "bytes" || h.get("Content-Length") !== String(remaining) ||
          (h.get("Content-Encoding") !== null && h.get("Content-Encoding") !== "identity") ||
          (start ? h.get("Content-Range") !== `bytes ${start}-${part.bytes - 1}/${part.bytes}` : h.has("Content-Range"))) {
        void response.body?.cancel().catch(() => {});
        throw invalid();
      }
      reader = response.body?.getReader();
      if (!reader) throw invalid();
      progress({ received: this.received, total: part.bytes, state: "receiving" });
      for (;;) {
        const chunk = await reader.read(); check();
        if (chunk.done) break;
        if (chunk.value.length > part.bytes - this.received) throw invalid();
        this.chunks.push(chunk.value.slice()); this.received += chunk.value.length;
        progress({ received: this.received, total: part.bytes, state: "receiving" });
      }
      if (this.received !== part.bytes) throw new Error("Transfer ended early. Retry explicitly to resume the retained bytes; no file was saved.");
      progress({ received: this.received, total: part.bytes, state: "verifying" });
      const bytes = new Uint8Array(part.bytes);
      let offset = 0;
      for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const digest = await crypto.subtle.digest("SHA-256", bytes); check();
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      if (hash !== part.sha256) throw invalid();
      const blob = new Blob([bytes], { type: "application/zip" });
      this.discard();
      return blob;
    } catch (error) {
      if (current() && generation === sessionGeneration() && error instanceof InvalidTransfer) this.discard();
      throw error;
    } finally {
      // Cancellation is best-effort and never publishes state.
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}

export function bundleFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "Saved rights or originals changed, or this request conflicts with an existing snapshot. Refresh snapshots and review source links; prepare a new snapshot only deliberately.";
    if (error.status === 410) return "This snapshot expired. Its partial bytes were discarded. Prepare a new snapshot explicitly, or use the existing individual downloads.";
    if ([412, 416].includes(error.status)) return "The saved range or checksum no longer matches. Partial bytes were discarded. Retry from the beginning or reopen the snapshot.";
    if (error.status === 429) return `Download capacity or snapshot quota is full.${error.retryAfter === undefined ? "" : ` Wait at least ${error.retryAfter} seconds.`} Retry explicitly, use an existing snapshot, or save individual originals.`;
    if (error.status === 404) return "This saved snapshot is unavailable in this plan. Refresh the snapshot list.";
  }
  return error instanceof Error ? error.message : "Download unavailable. No file was saved.";
}
