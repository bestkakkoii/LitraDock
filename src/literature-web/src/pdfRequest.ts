import { api, ApiError, sessionGeneration } from "./api";
import { planApi } from "./plans/api";

export class PdfRequest {
  readonly body: { requestID: string; searchIDs: string[]; format: "pdf"; runID?: string };
  readonly kind: "batch" | "plan";
  private receipt: string | null = null;
  constructor(readonly library: string, readonly runID: string, ids: string[], readonly generation: number, plansEnabled: boolean) {
    if (!runID || !library || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !id))
      throw new Error("Choose 1 to 100 distinct saved records.");
    this.kind = ids.length <= 10 ? "batch" : "plan";
    if (this.kind === "plan" && !plansEnabled) throw new Error("Processing plans are disabled. Select up to 10 records for a PDF batch.");
    this.body = { requestID: crypto.randomUUID(), searchIDs: [...ids], format: "pdf", ...(this.kind === "plan" ? { runID } : {}) };
  }
  get confirmedID() { return this.receipt; }
  async send(signal: AbortSignal) {
    const current = () => {
      if (signal.aborted || this.generation !== sessionGeneration()) throw new Error("PDF request scope changed.");
    };
    current();
    if (this.receipt) return this.receipt; // A confirmed POST is never repeated just because opening its detail failed.
    const id = this.kind === "batch"
      ? (await api.createBatch(this.library, this.body.requestID, this.body.searchIDs, this.generation, signal, "pdf")).id
      : (await planApi(this.library, this.generation).create({ ...this.body, runID: this.body.runID! }, signal)).planID;
    current();
    if (!id) throw new Error("PDF admission returned no saved identifier.");
    this.receipt = id;
    return id;
  }
}
export const definitiveAdmissionError = (error: unknown) => error instanceof ApiError && [400, 403, 404, 409].includes(error.status);
