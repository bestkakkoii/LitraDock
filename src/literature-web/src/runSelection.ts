import { ApiError, type Article, request, sessionGeneration } from "./api";

export type RunSelection = {
  runID: string; revision: number; defaultSelected: boolean;
  savedCount: number; selectedCount: number; selectedIDs: string[];
  selectedRecords: Article[]; recordsComplete: boolean; recordsReason: string;
  canEdit: boolean; selectionLimit: number; detailLimit: number;
};
export type SelectionIntent = { action: "all" } | { action: "none" } | { action: "set"; ids: string[]; selected: boolean };
export type SelectionAction = SelectionIntent & { requestID: string; revision: number };
type SelectionReceipt = { runID: string; requestID: string; revision: number };
export type PendingSelection = { body: SelectionAction; phase: "uncertain" | "conflict" | "rejected" | "refresh" };
export type SelectionState = {
  snapshot: RunSelection | null; pending: PendingSelection | null;
  phase: "loading" | "ready" | "saving" | "error" | PendingSelection["phase"];
  error: string;
};
const invalid = () => new Error("Saved selection is inconsistent. Reload the saved selection before continuing.");
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// IDs/counts and bounded metadata must describe one server snapshot. Never turn
// a partial metadata list into a smaller apparent selection.
export function validateSelection(value: unknown, runID: string): RunSelection {
  if (!object(value) || value.runID !== runID || !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
      typeof value.defaultSelected !== "boolean" || typeof value.canEdit !== "boolean" ||
      (value.selectionLimit !== 1000 && value.selectionLimit !== 20000) || value.detailLimit !== 100 ||
      !integer(value.savedCount, 0, value.selectionLimit) || !integer(value.selectedCount, 0, value.savedCount) ||
      !Array.isArray(value.selectedIDs) || value.selectedIDs.length !== value.selectedCount ||
      !value.selectedIDs.every(id => typeof id === "string" && id.length > 0 && id.length <= 256) ||
      new Set(value.selectedIDs).size !== value.selectedCount ||
      !Array.isArray(value.selectedRecords) || typeof value.recordsComplete !== "boolean" ||
      typeof value.recordsReason !== "string") throw invalid();
  const ids = new Set(value.selectedIDs);
  if (value.recordsComplete) {
    if (value.selectedCount > 100 || value.selectedRecords.length !== value.selectedCount ||
        !value.selectedRecords.every(record => object(record) && ids.has(record.SearchId)) ||
        new Set(value.selectedRecords.map(record => record.SearchId)).size !== value.selectedCount) throw invalid();
  } else if (value.selectedCount === 0 || value.selectedRecords.length !== 0 || !value.recordsReason.trim()) throw invalid();
  return value as RunSelection;
}

export function selectionIntentLabel(intent: SelectionIntent): string {
  return intent.action === "all" ? "Select all saved records" : intent.action === "none" ? "Deselect all saved records" :
    `${intent.selected ? "Select" : "Deselect"} ${intent.ids.length} saved ${intent.ids.length === 1 ? "record" : "records"}`;
}

export class RunSelectionController {
  state: SelectionState;
  private scope = new AbortController();
  private attempt?: AbortController;
  private sequence = 0;
  private locked = false;
  private stop = () => this.dispose();
  constructor(private library: string, private runID: string, private generation: number,
    private parent: AbortSignal, private changed: (state: SelectionState) => void,
    private remember: (pending: PendingSelection | null) => void,
    pending: PendingSelection | null = null) {
    this.state = { snapshot: null, pending, phase: pending?.phase ?? "loading", error: "" };
    parent.addEventListener("abort", this.stop, { once: true });
    if (parent.aborted) this.scope.abort();
  }
  private current() { return !this.scope.signal.aborted && !this.parent.aborted && this.generation === sessionGeneration(); }
  private publish(patch: Partial<SelectionState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...patch };
    this.remember(this.state.pending);
    this.changed(this.state);
  }
  private path() { return `/api/libraries/${encodeURIComponent(this.library)}/runs/${encodeURIComponent(this.runID)}/selection`; }
  private async read(signal: AbortSignal) {
    return validateSelection(await request<unknown>(this.path(), { signal }, this.generation, 8 * 1024 * 1024), this.runID);
  }
  // Passive membership refresh cannot discard an unresolved deliberate write.
  async load(discardIntent = false) {
    if (!this.current() || this.locked) return;
    if (discardIntent) this.publish({ pending: null });
    const sequence = ++this.sequence;
    this.attempt?.abort(); const controller = new AbortController(); this.attempt = controller;
    const signal = AbortSignal.any([controller.signal, this.scope.signal, AbortSignal.timeout(15000)]);
    this.publish({ phase: "loading", error: "" });
    try {
      const snapshot = await this.read(signal);
      if (!this.current() || sequence !== this.sequence) return;
      if (this.state.snapshot && snapshot.revision < this.state.snapshot.revision) throw invalid();
      this.publish({ snapshot, phase: this.state.pending?.phase ?? "ready", error: "" });
    } catch (failure) {
      if (sequence === this.sequence) this.publish({ phase: this.state.pending?.phase ?? "error", error: (failure as Error).message });
    }
  }
  async apply(intent: SelectionIntent) {
    if (!this.current() || this.locked || this.state.phase !== "ready" || !this.state.snapshot?.canEdit) return;
    if (intent.action === "set" && (intent.ids.length < 1 || intent.ids.length > 100 ||
        new Set(intent.ids).size !== intent.ids.length || intent.ids.some(id => !id))) return;
    const body: SelectionAction = { ...intent, ...(intent.action === "set" ? { ids: [...intent.ids] } : {}),
      requestID: crypto.randomUUID(), revision: this.state.snapshot.revision };
    this.publish({ pending: { body, phase: "uncertain" } });
    await this.retry();
  }
  async retry() {
    const pending = this.state.pending;
    if (!this.current() || this.locked || !pending || !["uncertain", "refresh"].includes(pending.phase)) return;
    this.locked = true; ++this.sequence; this.attempt?.abort();
    const controller = new AbortController(); this.attempt = controller;
    const signal = AbortSignal.any([controller.signal, this.scope.signal, AbortSignal.timeout(15000)]);
    this.publish({ phase: "saving", error: "" });
    let confirmed = pending.phase === "refresh";
    try {
      if (!confirmed) {
        const receipt = await request<SelectionReceipt>(this.path(),
          { method: "POST", body: JSON.stringify(pending.body), signal }, this.generation, 64 * 1024);
        if (!this.current()) return;
        if (receipt.runID !== this.runID || receipt.requestID !== pending.body.requestID ||
            receipt.revision !== pending.body.revision + 1) throw invalid();
        confirmed = true;
        this.publish({ pending: { body: pending.body, phase: "refresh" } });
      }
      const snapshot = await this.read(signal);
      if (!this.current()) return;
      if (snapshot.revision <= pending.body.revision || (this.state.snapshot && snapshot.revision < this.state.snapshot.revision)) throw invalid();
      this.publish({ snapshot, pending: null, phase: "ready", error: "" });
    } catch (failure) {
      const phase = confirmed ? "refresh" : failure instanceof ApiError && failure.status === 409 ? "conflict" :
        failure instanceof ApiError && [400, 403, 404, 422].includes(failure.status) ? "rejected" : "uncertain";
      this.publish({ pending: { body: pending.body, phase }, phase, error: phase === "conflict"
        ? "This selection change could not be applied. Reload the saved selection to check its current state and availability before choosing again."
        : phase === "rejected" ? "The selection change was rejected. Reload the saved selection before trying a new choice."
        : phase === "refresh" ? "Your change was received. Reload to read the current saved selection."
        : "The selection change is not confirmed. Retry the same change, or reload to use the server's saved choices." });
    } finally { this.locked = false; }
  }
  dispose() {
    this.scope.abort(); this.attempt?.abort(); ++this.sequence;
    this.parent.removeEventListener("abort", this.stop);
  }
}
