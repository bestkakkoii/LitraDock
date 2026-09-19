// Contract-only SYNTHETIC fixtures. Never used as a source response or demo data.
import { Continuation } from "../continuation/api";
import { ExportContext, ExportIntent, exportCounts } from "./api";
import { Capture } from "./capture";

export const runID = `RUN-${"1".repeat(32)}`;
export const capture = (patch: Partial<Capture> = {}): Capture => ({ strategy: "create_date_v1", state: "ready", pendingSegments: 2,
  completedSegments: 1, requests: 2, requestLimit: 256, membershipLimit: 20000, providerBoundary: 10000,
  latestProviderTotal: 700, order: "initial_then_segment", canCapture: true, reason: "SYNTHETIC coverage", ...patch });
export const continuation = (patch: Partial<Continuation> = {}): Continuation => ({ runID, revision: 7, state: "ready",
  execution: "user_browser", credentialMode: "unkeyed", canStart: false, canRecover: false, windowLimit: 20000,
  windowCount: 1003, processedCount: 1002, savedCount: 1001, missingCount: 1, providerTotal: 1000, pageSize: 100,
  attempts: 0, canContinue: true, canRetry: false, canCancel: false, reason: "SYNTHETIC", snapshotAt: "2026-09-20T00:00:00Z", capture: capture(), ...patch });
export const context = (patch: Partial<ExportContext> = {}): ExportContext => ({ runID, originalQuery: 'SYNTHETIC "治療"[Title] AND 2020:2024[dp]',
  selectionRevision: 12, captureRevision: 7, savedCount: 1001, capturedCount: 1003, processedCount: 1002, missingCount: 1,
  initialProviderTotal: 1000, selectedIDs: Array.from({ length: 1001 }, (_, i) => `SYNTHETIC-${i + 1}`), ...patch });
export const intent = (patch: Partial<ExportIntent> = {}): ExportIntent => ({ context: context(), scope: "selected", format: "json", offset: 0, limit: 1000, ...patch });
export function envelope(request: ExportIntent) {
  const c = request.context, counts = exportCounts(request);
  return { schema: "litradock.staged-query-export", schemaVersion: 1, type: "manifest", runId: c.runID,
    originalQuery: c.originalQuery, initialProviderTotal: c.initialProviderTotal, initialQueryProvenance: null,
    scope: request.format === "manifest" ? "captured_identities" : request.scope, selectionRevision: c.selectionRevision, captureRevision: c.captureRevision,
    savedCount: c.savedCount, capturedCount: c.capturedCount, processedCount: c.processedCount, missingCount: c.missingCount,
    ...counts, order: "initial_then_segment", capture: capture(),
    capturedIdentities: request.format === "manifest" ? Array.from({ length: c.capturedCount }, (_, i) => ({ pmid: String(990000001 + i), ordinal: i + 1,
      metadataState: i < c.savedCount ? "saved" : i < c.processedCount ? "missing" : "pending", searchId: i < c.savedCount ? `SYNTHETIC-${i + 1}` : null,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${990000001 + i}/`, segment: 1, segmentRank: i + 1 })) : undefined,
    records: request.format === "manifest" ? undefined : Array.from({ length: counts.count }, (_, i) => ({ searchId: c.selectedIDs[counts.offset + i], title: "SYNTHETIC = formula 中文 αβ",
        identifiers: { pmid: String(990000001 + counts.offset + i), pmcid: null, doi: null },
        membership: { pmid: String(990000001 + counts.offset + i), ordinal: counts.offset + i + 1, metadataState: "saved",
          searchId: c.selectedIDs[counts.offset + i], pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${990000001 + counts.offset + i}/`, segment: 1, segmentRank: i + 1 } })) };
}
export function headers(request: ExportIntent, type = "application/json") {
  const counts = exportCounts(request);
  return new Headers({ "Content-Type": type, "X-LitraDock-Selection-Revision": String(request.context.selectionRevision),
    "X-LitraDock-Capture-Revision": String(request.context.captureRevision), "X-LitraDock-Export-Count": String(counts.count),
    "X-LitraDock-Scope-Count": String(counts.scopeCount), "X-LitraDock-Export-Offset": String(counts.offset), "X-LitraDock-Export-Remaining": String(counts.remaining) });
}
