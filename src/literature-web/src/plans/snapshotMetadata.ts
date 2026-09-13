import { ApiError, requestBlob, sessionGeneration } from "../api";
import { TransferOptions } from "../transfer";
import { ExportIdentity } from "./exports";

export const metadataFormats = ["json", "jsonl", "csv", "xlsx"] as const;
export type MetadataFormat = typeof metadataFormats[number];
const media = { json: "application/json", jsonl: "application/x-ndjson", csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new Error("The snapshot metadata response is invalid or belongs to a different scope. No file was saved.");

export function metadataFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 429)
    return `Metadata export is busy. ${error.retryAfter === undefined ? "Wait before trying again" : `Wait at least ${error.retryAfter} seconds before trying again`}. No automatic retry was started and no file was saved.`;
  if (error instanceof ApiError && error.status === 409)
    return "Snapshot metadata could not be exported within the current limits or saved state. Refresh the snapshot and review its details before trying another format. No file was saved.";
  return `${error instanceof Error ? error.message : "Snapshot metadata is unavailable."} Refresh the saved snapshot or try again explicitly. No automatic retry was started.`;
}

export async function snapshotMetadata(library: string, plan: ExportIdentity, format: MetadataFormat,
  generation: number, signal: AbortSignal, transfer: TransferOptions = {}) {
  const current = () => { if (signal.aborted || generation !== sessionGeneration()) throw new Error("Snapshot export context changed. No file was saved."); };
  current();
  if (!library || plan.scopeKind !== "saved_snapshot" || !/^PLN-[0-9a-f]{32}$/.test(plan.planID) || !metadataFormats.includes(format)) throw invalid();
  const blob = await requestBlob(`/api/libraries/${encodeURIComponent(library)}/plans/${encodeURIComponent(plan.planID)}/metadata`,
    { method: "POST", body: JSON.stringify({ format }), signal }, generation, { ...transfer, maxBytes: 8 * 1024 * 1024, maxErrorBytes: 65536 });
  current();
  const [mime, ...parameters] = blob.type.toLowerCase().split(";").map(s => s.trim());
  if (mime !== media[format] || parameters.some(p => p.startsWith("charset=") && p !== "charset=utf-8") || !blob.size) throw invalid();
  const bytes = await blob.arrayBuffer(); current();
  if (format === "xlsx") {
    if (new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)).join(",") !== "80,75,3,4") throw invalid();
    // Full workbook serialization/integrity is the native serializer's responsibility.
  } else {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid(); }
    if (format === "csv") {
      if (!text.startsWith("Search ID,Title,Authors,Year,PMID,PMCID,DOI,") || !text.endsWith("\n")) throw invalid();
    } else {
      let envelope: any, records: any[];
      try {
        if (format === "json") { envelope = JSON.parse(text); records = envelope.records; }
        else {
          if (!text.endsWith("\n")) throw invalid();
          const lines = text.slice(0, -1).split("\n").map(line => JSON.parse(line)); envelope = lines.shift();
          records = lines.map(line => { if (!object(line) || line.type !== "record") throw invalid(); return line.record; });
        }
      } catch { throw invalid(); }
      if (!object(envelope) || envelope.schema !== "litradock.research-export" || envelope.schemaVersion !== 1 ||
        envelope.type !== (format === "json" ? "document" : "manifest") || "error" in envelope ||
        !object(envelope.scope) || envelope.scope.kind !== "saved_snapshot" || envelope.scope.planId !== plan.planID ||
        envelope.scope.runId !== null || envelope.scope.batchId !== null || envelope.scope.selection !== "all_saved_scope" ||
        !object(envelope.counts) || envelope.counts.exportedRecords !== plan.selectedCount || envelope.counts.scopeRecords !== plan.selectedCount ||
        !Array.isArray(envelope.queryContexts) || !Array.isArray(records) || records.length !== plan.selectedCount ||
        records.some(r => !object(r) || typeof r.searchId !== "string" || !r.searchId || !Array.isArray(r.runIds) ||
          !r.runIds.length || new Set(r.runIds).size !== r.runIds.length || r.runIds.some((id: unknown) => typeof id !== "string" || !plan.sourceRunIDs?.includes(id))) ||
        new Set(records.map(r => r.searchId)).size !== records.length ||
        new Set(records.flatMap(r => r.runIds)).size !== plan.sourceRunIDs?.length) throw invalid();
    }
  }
  current(); return { blob, filename: `litradock-saved-research.${format}` };
}
