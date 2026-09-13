import { ApiError, request, requestBlob, sessionGeneration } from "../api";
import { ExportIdentity } from "../plans/exports";
import { BundleDocument, BundleSummary, MiB, snapshotPattern, validateDocument, validateList } from "./model";
import { bundleFailure, PartProgress, PartTransfer } from "./transfer";

export type BundleState = {
  enabled: boolean; list: BundleSummary[]; document: BundleDocument | null; busy: string; error: string; notice: string;
  pending: boolean; selected: number[]; progress: Record<number, PartProgress>; handed: number[]; activePart: number | null;
};
const initial = (): BundleState => ({ enabled: false, list: [], document: null, busy: "", error: "", notice: "", pending: false,
  selected: [], progress: {}, handed: [], activePart: null });
export class BundleController {
  state = initial();
  private scope = new AbortController();
  private operation = new AbortController();
  private serial = 0;
  private pendingBody: string | null = null;
  private transfer = new PartTransfer();
  private manifestBlob: Blob | null = null;
  private base: string;
  constructor(private library: string, private plan: ExportIdentity, private generation: number,
    private publish: (state: BundleState) => void, private deviceSave: (blob: Blob, name: string) => void) {
    this.plan = { ...plan, sourceRunIDs: plan.sourceRunIDs && [...plan.sourceRunIDs] };
    this.base = `/api/libraries/${encodeURIComponent(library)}/plans/${encodeURIComponent(plan.planID)}/bundles`;
  }
  private live = () => !this.scope.signal.aborted && this.generation === sessionGeneration();
  private emit(patch: Partial<BundleState>) { if (this.live()) { this.state = { ...this.state, ...patch }; this.publish(this.state); } }
  private begin(busy: string, discard = false) {
    this.operation.abort(); this.operation = new AbortController();
    const id = ++this.serial, signal = AbortSignal.any([this.scope.signal, this.operation.signal]);
    if (discard) this.transfer.discard();
    this.emit({ busy, error: "", notice: "", activePart: null });
    const current = () => this.live() && !signal.aborted && id === this.serial;
    return { signal, current };
  }
  dispose() { this.scope.abort(); this.operation.abort(); this.serial++; this.transfer.discard(); this.manifestBlob = null; this.pendingBody = null; this.state = initial(); }
  async initialize() {
    const { signal, current } = this.begin("Loading saved snapshots…");
    try {
      const capability = await request<{ bundleDeliveryEnabled?: boolean }>("/service-info", { signal }, this.generation, 64 * 1024);
      if (!current()) return;
      this.emit({ enabled: capability.bundleDeliveryEnabled === true });
      const list = validateList(await request<unknown>(this.base, { signal }, this.generation, 64 * 1024), this.plan.planID);
      if (current()) this.emit({ list });
    } catch (error) { if (current()) this.emit({ error: bundleFailure(error) }); }
    finally { if (current()) this.emit({ busy: "" }); }
  }
  async refresh() {
    if (!this.live() || this.state.busy) return;
    const { signal, current } = this.begin("Refreshing saved snapshots…");
    try {
      const list = validateList(await request<unknown>(this.base, { signal }, this.generation, 64 * 1024), this.plan.planID);
      if (current()) this.emit({ list });
    } catch (error) { if (current()) this.emit({ error: bundleFailure(error) }); }
    finally { if (current()) this.emit({ busy: "" }); }
  }
  private accept(document: BundleDocument, blob: Blob | null) {
    this.transfer.discard(); this.manifestBlob = blob;
    this.emit({ document, selected: document.parts.map(p => p.number), progress: {}, handed: [], activePart: null });
  }
  private async readDocument(id: string, signal: AbortSignal, current: () => boolean) {
    const blob = await requestBlob(`${this.base}/${id}`, { signal }, this.generation, { maxBytes: 8 * MiB, maxErrorBytes: 64 * 1024 });
    if (!current()) return;
    if (blob.type.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("The saved manifest was not JSON. No file was saved.");
    const bytes = await blob.arrayBuffer();
    if (!current()) return;
    const document = validateDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), this.plan, id);
    if (current()) this.accept(document, blob);
  }
  async open(id: string) {
    if (!this.live() || !snapshotPattern.test(id)) return;
    const { signal, current } = this.begin("Opening saved snapshot…", true);
    this.manifestBlob = null;
    this.emit({ document: null, selected: [], progress: {}, handed: [] });
    try { await this.readDocument(id, signal, current); }
    catch (error) { if (current()) this.emit({ error: bundleFailure(error) }); }
    finally { if (current()) this.emit({ busy: "" }); }
  }
  async prepare() {
    if (!this.live() || this.state.busy || (!this.state.enabled && !this.pendingBody)) return;
    // The only way out of uncertain admission is an explicit identical replay,
    // or scope retirement. Navigation and changed checkbox intent cannot replace it.
    this.pendingBody ??= JSON.stringify({ requestID: crypto.randomUUID() });
    const body = this.pendingBody;
    const { signal, current } = this.begin("Preparing download parts…", true);
    this.emit({ pending: true });
    let confirmed = false;
    try {
      const receipt = await requestBlob(this.base, { method: "POST", body, signal }, this.generation, { maxBytes: 8 * MiB, maxErrorBytes: 64 * 1024 });
      if (!current()) return;
      if (receipt.type.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("Preparation did not return a JSON snapshot.");
      const bytes = await receipt.arrayBuffer();
      if (!current()) return;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const document = validateDocument(value, this.plan);
      confirmed = true; this.pendingBody = null;
      this.emit({ pending: false }); this.accept(document, null);
      // Receipt already identifies the durable snapshot. A failed GET cannot
      // revert that commitment or offer another POST as a recovery action.
      await this.readDocument(document.snapshotID, signal, current);
      if (current()) this.emit({ notice: "Snapshot prepared. No originals were downloaded or acquired." });
    } catch (error) {
      if (!current()) return;
      if (!confirmed && error instanceof ApiError && [400, 404, 409, 410].includes(error.status)) { this.pendingBody = null; this.emit({ pending: false }); }
      this.emit({ error: `${bundleFailure(error)}${this.pendingBody ? " Preparation is unconfirmed. Retry the same preparation request explicitly; do not create a replacement." : confirmed ? " Snapshot is confirmed. Reopen this saved snapshot with GET to recover its manifest." : ""}` });
    } finally { if (current()) this.emit({ busy: "" }); }
  }
  select(numbers: number[]) {
    if (this.state.busy || !this.state.document) return;
    const available = new Set(this.state.document.parts.map(p => p.number));
    this.emit({ selected: [...new Set(numbers)].filter(n => available.has(n)) });
  }
  saveManifest() {
    if (!this.live() || this.state.busy || !this.manifestBlob) return;
    this.deviceSave(this.manifestBlob, "litradock-bundle-manifest.json");
    this.emit({ notice: "Complete saved manifest sent to your browser. Availability describes preparation time." });
  }
  get hasManifest() { return this.manifestBlob !== null; }
  cancel() {
    if (this.state.activePart === null) return;
    const n = this.state.activePart, progress = this.state.progress[n];
    this.operation.abort(); this.serial++;
    if (progress?.received === progress?.total) this.transfer.discard();
    this.emit({ busy: "", activePart: null, progress: { ...this.state.progress, ...(progress ? { [n]: { ...progress, received: this.transfer.retainedBytes, state: "paused" as const } } : {}) },
      notice: "Queue paused. Current part bytes remain only in this tab. Retry that part to resume; choosing another part discards them. No partial file was saved." });
  }
  async download(numbers: number[]) {
    const document = this.state.document;
    if (!this.live() || this.state.busy || !document || !numbers.length) return;
    const parts = document.parts.filter(p => new Set(numbers).has(p.number));
    const { signal, current } = this.begin("Downloading selected parts…");
    try {
      for (const part of parts) {
        if (!current()) return;
        this.emit({ activePart: part.number });
        const blob = await this.transfer.read(`${this.base}/${document.snapshotID}/parts/${part.number}`, part, signal, this.generation, current,
          value => { if (current()) this.emit({ progress: { ...this.state.progress, [part.number]: value } }); });
        if (!current()) return;
        this.deviceSave(blob, part.filename);
        this.emit({ handed: [...new Set([...this.state.handed, part.number])], progress: { ...this.state.progress, [part.number]: { received: part.bytes, total: part.bytes, state: "ready" } } });
      }
      if (current()) this.emit({ notice: "Verified parts sent to your browser. Check browser downloads; multiple files may require browser permission." });
    } catch (error) {
      if (current()) {
        const n = this.state.activePart, p = n === null ? null : this.state.progress[n];
        this.emit({ error: `${bundleFailure(error)} Queue paused; retry the failed part explicitly. No partial file was saved.`,
          ...(n !== null && p ? { progress: { ...this.state.progress, [n]: { ...p, received: this.transfer.retainedBytes, state: "paused" as const } } } : {}) });
      }
    } finally { if (current()) this.emit({ busy: "", activePart: null }); }
  }
}
