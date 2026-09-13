import { requestBlob, sessionGeneration } from "./api";
import { TransferOptions } from "./transfer";

export type StructuredFormat = "json" | "jsonl";
export type ExportScope = { runID: string; batchID?: never } | { batchID: string; runID?: never };

const mediaTypes = { json: "application/json", jsonl: "application/x-ndjson" } as const;
const invalidExport = () => new Error("The server did not return a valid research export. No file was saved.");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Validate the transport envelope, not publication completeness. Optional metadata
// remains exactly as returned; do not reserialize or normalize identifiers/text.
export async function structuredExport(
  library: string,
  scope: ExportScope,
  format: StructuredFormat,
  generation: number,
  signal: AbortSignal,
  transfer: TransferOptions = {},
): Promise<{ blob: Blob; filename: string }> {
  const current = () => {
    if (signal.aborted || generation !== sessionGeneration())
      throw new Error("The export context changed. No file was saved.");
  };
  current();
  if (!library || !["json", "jsonl"].includes(format) ||
      Object.keys(scope).length !== 1 ||
      !((typeof scope.runID === "string" && scope.runID) ||
        (typeof scope.batchID === "string" && scope.batchID))) throw invalidExport();
  const expectedScope = scope.runID !== undefined
    ? { kind: "run", runId: scope.runID, batchId: null }
    : { kind: "batch", runId: null, batchId: scope.batchID };
  const blob = await requestBlob(
    `/api/libraries/${encodeURIComponent(library)}/exports`,
    { method: "POST", body: JSON.stringify({ ...scope, format }), signal },
    generation,
    { ...transfer, maxBytes: 8 * 1024 * 1024 },
  );
  current();
  const [mime, ...parameters] = blob.type.toLowerCase().split(";").map(value => value.trim());
  // Browser Blob types may contain only the media essence. Validate UTF-8 from
  // the bytes below; reject a conflicting charset when the Blob retains one.
  if (mime !== mediaTypes[format] || parameters.some(value => value.startsWith("charset=") && value !== "charset=utf-8") || blob.size > 8 * 1024 * 1024)
    throw invalidExport();
  const bytes = await blob.arrayBuffer();
  current();
  let envelope: unknown;
  let records: unknown[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (format === "json") {
      envelope = JSON.parse(text);
      records = object(envelope) && Array.isArray(envelope.records) ? envelope.records : [];
      if (!object(envelope) || !Array.isArray(envelope.records)) throw invalidExport();
    } else {
      if (!text.endsWith("\n")) throw invalidExport();
      const lines = text.slice(0, -1).split("\n").map(line => JSON.parse(line) as unknown);
      envelope = lines.shift();
      records = lines.map(line => {
        if (!object(line) || line.type !== "record" || !object(line.record)) throw invalidExport();
        return line.record;
      });
    }
  } catch { throw invalidExport(); }
  if (!object(envelope) || envelope.schema !== "litradock.research-export" ||
      envelope.schemaVersion !== 1 || envelope.type !== (format === "json" ? "document" : "manifest") ||
      "error" in envelope || !object(envelope.scope) || !object(envelope.counts) ||
      envelope.scope.kind !== expectedScope.kind || envelope.scope.runId !== expectedScope.runId ||
      envelope.scope.batchId !== expectedScope.batchId || envelope.scope.selection !== "all_saved_scope" ||
      !Array.isArray(envelope.queryContexts) || records.length < 1 || records.length > 1000 ||
      envelope.counts.exportedRecords !== records.length || envelope.counts.scopeRecords !== records.length ||
      !records.every(record => object(record) && typeof record.searchId === "string" && record.searchId.length > 0))
    throw invalidExport();
  if (new Set(records.map(record => (record as Record<string, unknown>).searchId)).size !== records.length)
    throw invalidExport();
  current();
  return { blob, filename: `litradock-research.${format}` };
}
