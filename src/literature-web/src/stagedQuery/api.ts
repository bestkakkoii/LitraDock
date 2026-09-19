import { ApiError, requestBlob, sessionGeneration } from "../api";
import { Continuation, validRunID } from "../continuation/api";
import { RunSelection } from "../runSelection";
import { TransferOptions } from "../transfer";
import { validateCapture } from "./capture";

export type MetadataFormat = "csv" | "xlsx" | "json" | "jsonl";
export type ExportKind = MetadataFormat | `zip-${MetadataFormat}` | "manifest";
export type ExportScope = "all" | "selected";
export type ExportContext = {
  runID: string; originalQuery: string; selectionRevision: number; captureRevision: number;
  savedCount: number; capturedCount: number; processedCount: number; missingCount: number;
  initialProviderTotal: number; selectedIDs: readonly string[];
};
export type ExportIntent = { context: ExportContext; scope: ExportScope; format: ExportKind; offset: number; limit: number };
export type ExportCounts = { scopeCount: number; offset: number; count: number; remaining: number; complete: boolean };
export type ExportResult = ExportCounts & { blob: Blob; filename: string };
const invalid = () => new Error("The export did not match the saved scope or was incomplete. No file was saved; refresh saved progress and selection.");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const media: Record<ExportKind, string> = {
  csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json", jsonl: "application/x-ndjson", manifest: "application/json",
  "zip-csv": "application/zip", "zip-xlsx": "application/zip", "zip-json": "application/zip", "zip-jsonl": "application/zip",
};

export function exportContext(status: Continuation, selection: RunSelection, originalQuery: string): ExportContext | null {
  if (!status.capture || status.runID !== selection.runID || status.savedCount !== selection.savedCount) return null;
  return { runID: status.runID, originalQuery, selectionRevision: selection.revision, captureRevision: status.revision,
    savedCount: status.savedCount, capturedCount: status.windowCount, processedCount: status.processedCount,
    missingCount: status.missingCount, initialProviderTotal: status.providerTotal, selectedIDs: [...selection.selectedIDs] };
}
export function exportCounts(intent: ExportIntent): ExportCounts {
  const c = intent.context, whole = intent.format.startsWith("zip-");
  if (!validRunID(c.runID) || typeof c.originalQuery !== "string" ||
      !integer(c.selectionRevision, 1, Number.MAX_SAFE_INTEGER) || !integer(c.captureRevision, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(c.initialProviderTotal, 0, Number.MAX_SAFE_INTEGER) || !integer(c.capturedCount, 0, 20000) ||
      !integer(c.processedCount, 0, c.capturedCount) || !integer(c.savedCount, 0, c.processedCount) ||
      c.savedCount + c.missingCount !== c.processedCount || !integer(c.missingCount, 0, c.processedCount) ||
      !Array.isArray(c.selectedIDs) || c.selectedIDs.length > c.savedCount || new Set(c.selectedIDs).size !== c.selectedIDs.length ||
      c.selectedIDs.some(id => typeof id !== "string" || !id || id.length > 256) ||
      !["all", "selected"].includes(intent.scope) || !Object.hasOwn(media, intent.format) ||
      !integer(intent.limit, 1, 1000)) throw invalid();
  const scopeCount = intent.format === "manifest" ? c.capturedCount : intent.scope === "selected" ? c.selectedIDs.length : c.savedCount;
  if (!integer(intent.offset, 0, Math.max(0, scopeCount - 1)) || ((whole || intent.format === "manifest") && intent.offset !== 0) ||
      (intent.format !== "manifest" && scopeCount === 0)) throw invalid();
  const count = whole || intent.format === "manifest" ? scopeCount : Math.min(intent.limit, scopeCount - intent.offset);
  const remaining = scopeCount - intent.offset - count;
  return { scopeCount, offset: intent.offset, count, remaining, complete: intent.offset === 0 && remaining === 0 };
}
export function exportFilename(intent: ExportIntent, counts: ExportCounts): string {
  const c = intent.context, identity = `${c.runID}-s${c.selectionRevision}-c${c.captureRevision}`;
  if (intent.format === "manifest") return `litradock-captured-ids-${identity}.json`;
  if (intent.format.startsWith("zip-")) return `litradock-${intent.scope}-${identity}-${intent.format.slice(4)}.zip`;
  return `litradock-${intent.scope}-${identity}-records-${counts.offset + 1}-${counts.offset + counts.count}-of-${counts.scopeCount}.${intent.format}`;
}
function validateHeaders(response: Response, intent: ExportIntent, counts: ExportCounts) {
  const c = intent.context;
  const expected = { "X-LitraDock-Selection-Revision": c.selectionRevision, "X-LitraDock-Capture-Revision": c.captureRevision,
    "X-LitraDock-Export-Count": counts.count, "X-LitraDock-Scope-Count": counts.scopeCount,
    "X-LitraDock-Export-Offset": counts.offset, "X-LitraDock-Export-Remaining": counts.remaining };
  if (Object.entries(expected).some(([name, count]) => response.headers.get(name) !== String(count))) throw invalid();
}
function validateEnvelope(value: unknown, intent: ExportIntent, counts: ExportCounts): asserts value is Record<string, unknown> {
  const c = intent.context;
  if (!object(value) || value.schema !== "litradock.staged-query-export" || value.schemaVersion !== 1 || value.type !== "manifest" ||
      value.runId !== c.runID || value.originalQuery !== c.originalQuery || value.selectionRevision !== c.selectionRevision || value.captureRevision !== c.captureRevision ||
      value.initialProviderTotal !== c.initialProviderTotal || value.savedCount !== c.savedCount || value.capturedCount !== c.capturedCount ||
      value.processedCount !== c.processedCount || value.missingCount !== c.missingCount || value.order !== "initial_then_segment" ||
      value.scope !== (intent.format === "manifest" ? "captured_identities" : intent.scope) || Object.entries(counts).some(([key, count]) => value[key] !== count) ||
      (value.initialQueryProvenance !== null && !object(value.initialQueryProvenance)) ||
      (value.stages !== undefined && !Array.isArray(value.stages)) || (value.pendingSegments !== undefined && !Array.isArray(value.pendingSegments)) || "error" in value) throw invalid();
  validateCapture(value.capture);
}
function validMember(value: unknown, context: ExportContext): value is Record<string, unknown> {
  return object(value) && typeof value.pmid === "string" && /^\d{1,20}$/.test(value.pmid) &&
    integer(value.ordinal, 1, context.capturedCount) && ["saved", "missing", "pending"].includes(String(value.metadataState)) &&
    (value.metadataState === "saved" ? typeof value.searchId === "string" && !!value.searchId : value.searchId === null) &&
    value.pubmedUrl === `https://pubmed.ncbi.nlm.nih.gov/${value.pmid}/` && integer(value.segment, 0, 1024) && integer(value.segmentRank, 1, 10000);
}
function validateRecords(records: unknown[], intent: ExportIntent, counts: ExportCounts) {
  if (records.length !== counts.count || records.some(record => !object(record) || typeof record.searchId !== "string" || !record.searchId ||
      !validMember(record.membership, intent.context) || record.membership.metadataState !== "saved" || record.membership.searchId !== record.searchId ||
      (record.membershipProvenance != null && !object(record.membershipProvenance))) ||
      new Set(records.map(record => (record as Record<string, unknown>).searchId)).size !== records.length) throw invalid();
  if (intent.scope === "selected" && records.some((record, i) =>
      (record as Record<string, unknown>).searchId !== intent.context.selectedIDs[counts.offset + i])) throw invalid();
}
function validateManifest(members: unknown, context: ExportContext) {
  if (!Array.isArray(members) || members.length !== context.capturedCount || members.some((member, i) =>
      !validMember(member, context) || member.ordinal !== i + 1 || (i >= context.processedCount) !== (member.metadataState === "pending")) ||
      new Set(members.map(member => member.pmid)).size !== members.length) throw invalid();
  const saved = members.filter(member => member.metadataState === "saved");
  if (saved.length !== context.savedCount || new Set(saved.map(member => member.searchId)).size !== saved.length ||
      members.filter(member => member.metadataState === "missing").length !== context.missingCount) throw invalid();
}

// Validate a complete single-disk ZIP container, preserving its exact bytes.
// Record/cell fidelity is qualified by the server encoders, not by this check.
export function validateZip(bytes: Uint8Array) {
  if (bytes.length < 22) throw invalid();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && data.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || data.getUint32(end, true) !== 0x06054b50 || end + 22 + data.getUint16(end + 20, true) !== bytes.length ||
      data.getUint16(end + 4, true) !== 0 || data.getUint16(end + 6, true) !== 0) throw invalid();
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), start = data.getUint32(end + 16, true);
  if (!count || count === 65535 || count !== data.getUint16(end + 8, true) || start + size !== end) throw invalid();
  let position = start;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || data.getUint32(position, true) !== 0x02014b50) throw invalid();
    const flags = data.getUint16(position + 8, true), method = data.getUint16(position + 10, true);
    const nameLength = data.getUint16(position + 28, true), extra = data.getUint16(position + 30, true), comment = data.getUint16(position + 32, true);
    const local = data.getUint32(position + 42, true), compressed = data.getUint32(position + 20, true);
    if ((flags & 1) || ![0, 8].includes(method) || !nameLength || position + 46 + nameLength + extra + comment > end ||
        local + 30 > start || data.getUint32(local, true) !== 0x04034b50 ||
        local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true) + compressed > start) throw invalid();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (names.has(name) || /[\\:\x00]/.test(name) || name.startsWith("/") || name.split("/").some(part => part === "..")) throw invalid();
    names.add(name); position += 46 + nameLength + extra + comment;
  }
  if (position !== end) throw invalid();
}

export async function downloadExport(library: string, intent: ExportIntent, generation: number, signal: AbortSignal,
  transfer: TransferOptions = {}): Promise<ExportResult> {
  const current = () => { if (signal.aborted || generation !== sessionGeneration()) throw new Error("The export context changed. No file was saved."); };
  current();
  if (!library) throw invalid();
  const counts = exportCounts(intent), archive = intent.format.startsWith("zip-");
  const params = new URLSearchParams({ format: intent.format, scope: intent.scope, revision: String(intent.context.selectionRevision),
    captureRevision: String(intent.context.captureRevision), offset: String(intent.offset), limit: String(intent.limit) });
  const blob = await requestBlob(`/api/libraries/${encodeURIComponent(library)}/runs/${encodeURIComponent(intent.context.runID)}/capture-export?${params}`,
    { signal }, generation, { ...transfer, maxBytes: (archive ? 64 : 8) * 1024 * 1024, maxErrorBytes: 64 * 1024,
      validateResponse: response => validateHeaders(response, intent, counts) });
  current();
  const [mime, ...parameters] = blob.type.toLowerCase().split(";").map(value => value.trim());
  if (mime !== media[intent.format] || !blob.size || parameters.some(value => value.startsWith("charset=") && value !== "charset=utf-8")) throw invalid();
  const bytes = new Uint8Array(await blob.arrayBuffer()); current();
  if (archive || intent.format === "xlsx") validateZip(bytes);
  else if (intent.format !== "csv") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let envelope: unknown, records: unknown[] = [];
      if (intent.format === "jsonl") {
        if (!text.endsWith("\n")) throw invalid();
        const lines = text.slice(0, -1).split("\n").map(line => JSON.parse(line) as unknown);
        envelope = lines.shift(); records = lines;
      } else {
        envelope = JSON.parse(text);
        if (object(envelope) && Array.isArray(envelope.records)) records = envelope.records;
      }
      validateEnvelope(envelope, intent, counts);
      if (intent.format !== "manifest") validateRecords(records, intent, counts);
      else validateManifest(envelope.capturedIdentities ?? [], intent.context);
    } catch { throw invalid(); }
  } else { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid(); } }
  current();
  return { ...counts, blob, filename: exportFilename(intent, counts) };
}
export function exportError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return "Saved results or selection changed. Refresh both, then start a new export. No file was saved.";
  if (error instanceof ApiError && error.status === 413) return "This export exceeds a file or text limit. Choose fewer records per part or download individual parts. No file was saved.";
  if (error instanceof ApiError && error.status === 429) return "Another export is being prepared. Wait, then retry explicitly. No automatic retry was started.";
  return error instanceof Error ? error.message : "Export unavailable. No file was saved.";
}
