import { sessionGeneration } from "../api";
import { TransferProgress } from "../transfer";
import { downloadExport, ExportContext, exportError, ExportKind, ExportResult, ExportScope } from "./api";
import { countLabel } from "./capture";

export type ExportState = { busy: boolean; offset: number; result: Omit<ExportResult, "blob"> | null;
  error: string; notice: string; progress?: TransferProgress };
export const emptyExportState = (): ExportState => ({ busy: false, offset: 0, result: null, error: "", notice: "" });

export class StagedExportController {
  state = emptyExportState();
  private active = new AbortController();
  private retired = false;
  private sequence = 0;
  private stop = () => this.dispose();
  constructor(readonly library: string, readonly context: ExportContext, readonly generation: number, private parent: AbortSignal,
    private publish: (state: ExportState) => void, private handoff: (blob: Blob, filename: string) => void) {
    parent.addEventListener("abort", this.stop, { once: true });
    if (parent.aborted) this.dispose();
  }
  private current() { return !this.retired && !this.parent.aborted && sessionGeneration() === this.generation; }
  private set(patch: Partial<ExportState>) { if (this.current()) { this.state = { ...this.state, ...patch }; this.publish(this.state); } }
  resetParts() { if (!this.state.busy) this.set({ offset: 0, result: null, error: "", notice: "" }); }
  cancel() {
    this.active.abort(); this.sequence++;
    this.set({ busy: false, progress: undefined, notice: "Export cancelled. No file was sent to your browser; the next part is unchanged." });
  }
  async save(format: ExportKind, scope: ExportScope, limit: number) {
    if (!this.current() || this.state.busy) return;
    const part = format !== "manifest" && !format.startsWith("zip-");
    const offset = part ? this.state.offset : 0;
    this.active.abort(); this.active = new AbortController();
    const signal = AbortSignal.any([this.active.signal, this.parent, AbortSignal.timeout(format.startsWith("zip-") ? 70000 : 30000)]);
    const sequence = ++this.sequence;
    const current = () => this.current() && !signal.aborted && sequence === this.sequence;
    const context = { ...this.context, selectedIDs: [...this.context.selectedIDs] };
    this.set({ busy: true, error: "", notice: "Preparing metadata export…", progress: undefined });
    try {
      const result = await downloadExport(this.library, { context, format, scope, offset, limit }, this.generation, signal,
        { onProgress: progress => { if (current()) this.set({ progress }); } });
      if (!current()) return;
      this.handoff(result.blob, result.filename);
      const { blob: _blob, ...receipt } = result;
      this.set({ result: receipt, offset: part ? offset + result.count : this.state.offset,
        notice: format === "manifest" ? "Captured-ID manifest sent to your browser, including unresolved source links."
          : part ? `Records ${offset + 1}–${offset + result.count} of ${result.scopeCount} sent to your browser · ${result.remaining} remaining. ${result.complete ? "All parts sent for this saved scope." : "This file is one part of the export."}`
          : `${countLabel(result.count, "saved metadata record")} sent to your browser in one ZIP. ${scope === "all" ? "Unsaved captured IDs remain listed in its manifest." : "The manifest covers the selected saved members."}` });
    } catch (error) { if (this.current() && sequence === this.sequence) this.set({ error: exportError(error), notice: "" }); }
    finally { if (this.current() && sequence === this.sequence) this.set({ busy: false, progress: undefined }); }
  }
  dispose() { this.retired = true; this.active.abort(); this.sequence++; this.parent.removeEventListener("abort", this.stop); }
}
