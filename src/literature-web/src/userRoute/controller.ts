import { api, ApiError, request, sessionGeneration } from "../api";
import { validateReceipt } from "../continuation/api";
import { providerKey } from "./credentials";
import { withSourceSlot } from "./scheduler";
import { Descriptor, fetchPubMed, SourceFailure, validateDescriptor } from "./transport";

type Pending = { run: string; kind: "claim"; body: { requestID: string; revision: number } } |
  { run: string; kind: "upload"; body: { attemptID: string; body?: string; failure?: string } };
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
export class BrowserRouteController {
  pending: Pending | null = null;
  constructor(readonly library: string, readonly generation: number, private update: (notice: string, pending: boolean) => void) {}
  private current(signal: AbortSignal) { signal.throwIfAborted(); if (sessionGeneration() !== this.generation) throw new DOMException("Session changed", "AbortError"); }
  private path(run: string, action: string) { return `/api/libraries/${encodeURIComponent(this.library)}/runs/${encodeURIComponent(run)}/user-route/${action}`; }
  private set(pending: Pending | null, notice: string) { this.pending = pending; this.update(notice, pending !== null); }
  private async upload(signal: AbortSignal) {
    const pending = this.pending;
    if (pending?.kind !== "upload") return;
    this.current(signal);
    const value = await request(this.path(pending.run, "upload"), { method: "POST", body: JSON.stringify(pending.body), signal }, this.generation, 16384);
    validateReceipt(value, pending.run); this.current(signal);
    this.set(null, "Browser response saved. Source provenance is labelled as client submitted.");
  }
  async reconcile(signal: AbortSignal): Promise<string | null> {
    const pending = this.pending;
    if (!pending) return null;
    if (pending.kind === "upload") { await this.upload(signal); return pending.run; }
    const value = await request<Descriptor>(this.path(pending.run, "claim"), { method: "POST", body: JSON.stringify(pending.body), signal }, this.generation, 16384);
    validateDescriptor(value, pending.run); this.current(signal);
    // Even a new admission returned to a reconciliation-only operation cannot
    // authorize another source call. An uncertain initial request stays unknown.
    this.set(null, "Source admission reconciled. Refresh saved progress; no provider request was repeated.");
    return pending.run;
  }
  async execute(run: string, signal: AbortSignal) {
    if (this.pending) throw new Error("Retry saving the previous browser results before starting another source request.");
    // One explicit page action: at most initial ESearch plus its first EFetch.
    // Existing frozen windows issue only that one metadata page.
    for (let stage = 0; stage < 2; stage++) {
      this.current(signal);
      const page = await api.run(this.library, run, 0, this.generation, 25, signal);
      const status = page.continuation;
      if (!status || status.execution !== "user_browser" || !status.canStart) return;
      const mode = status.credentialMode!;
      providerKey(mode); // Missing keys cannot consume an attempt or fall back.
      let continueInitial = false;
      await withSourceSlot(mode, signal, async () => {
        this.current(signal); providerKey(mode);
        const claim = { requestID: crypto.randomUUID(), revision: status.revision };
        this.set({ run, kind: "claim", body: claim }, "Waiting for the browser request receipt…");
        let value: Descriptor;
        try { value = await request<Descriptor>(this.path(run, "claim"), { method: "POST", body: JSON.stringify(claim), signal }, this.generation, 16384); }
        catch (error) {
          if (error instanceof ApiError && [400, 409, 429].includes(error.status))
            this.set(null, "Source request was not admitted. Refresh saved progress and respect the session cooldown before trying again.");
          throw error;
        }
        const d = validateDescriptor(value, run); this.current(signal);
        if (!d.fresh) { this.set(null, "Existing attempt found; no source request was repeated. Refresh saved progress."); return; }
        this.set(null, d.stage === "esearch" ? "Searching PubMed from this browser…" : "Retrieving PubMed metadata from this browser…");
        let body: Uint8Array;
        try { body = await fetchPubMed(d, signal); }
        catch (error) {
          if (error instanceof SourceFailure) {
            this.set({ run, kind: "upload", body: { attemptID: d.attemptID, failure: error.code } }, error.message);
            await this.upload(signal); throw error;
          }
          throw error;
        }
        this.current(signal);
        this.set({ run, kind: "upload", body: { attemptID: d.attemptID, body: base64(body) } }, "Saving the browser response…");
        try { await this.upload(signal); }
        catch (error) {
          if (error instanceof ApiError && [400, 409].includes(error.status)) {
            this.set(null, "Response validation or saved state changed. Refresh saved progress; no source retry was made.");
          }
          throw error;
        }
        continueInitial = d.stage === "esearch";
      });
      if (!continueInitial) return;
    }
  }
  async recover(run: string, attemptID: string, signal: AbortSignal) {
    const value = await request(this.path(run, "recover"), { method: "POST", body: JSON.stringify({ attemptID }), signal }, this.generation, 16384);
    validateReceipt(value, run); this.current(signal);
  }
  dispose() { this.pending = null; }
}
