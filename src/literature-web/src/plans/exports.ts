import { ApiError, requestBlob, sessionGeneration } from "../api";
import { phases, PlanSummary, validateSummary } from "./api";
import { TransferOptions } from "../transfer";

export type PlanExportFormat = "json" | "zip";
export type ExportIdentity = Pick<PlanSummary, "planID" | "runID" | "selectedCount" | "scopeKind" | "sourceRunIDs">;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = () => new Error("The server returned an invalid plan export. No file was saved.");

export function validatePlanMetadata(value: unknown, expected: ExportIdentity) {
  if (!object(value) || value.schema !== "litradock.plan-export" || value.schemaVersion !== 1 ||
      value.type !== "document" || value.originalsRevalidated !== false || "error" in value ||
      typeof value.generatedAt !== "string" || !value.generatedAt.endsWith("Z") || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !object(value.plan) || !object(value.research) || !object(value.counts) || !Array.isArray(value.items)) throw invalid();
  const plan = value.plan as PlanSummary, research = value.research, items = value.items, counts = value.counts;
  validateSummary(plan);
  if (plan.scopeKind !== expected.scopeKind || (expected.scopeKind &&
    JSON.stringify(plan.sourceRunIDs) !== JSON.stringify(expected.sourceRunIDs))) throw invalid();
  if (plan.planID !== expected.planID || plan.runID !== expected.runID || plan.selectedCount !== expected.selectedCount ||
      value.counts.members !== plan.selectedCount || items.length !== plan.selectedCount ||
      ["includedRecords", "unresolvedRecords", "uniqueOriginals", "originalBytes"].some(key => counts[key] !== null) ||
      research.schema !== "litradock.research-export" || research.schemaVersion !== 1 || research.type !== "document" ||
      !object(research.scope) || research.scope.kind !== (expected.scopeKind === "saved_snapshot" ? "saved_snapshot" : "plan") || research.scope.planId !== expected.planID ||
      research.scope.runId !== null || research.scope.batchId !== null || research.scope.selection !== "all_saved_scope" ||
      !object(research.counts) || research.counts.exportedRecords !== items.length || research.counts.scopeRecords !== items.length ||
      research.counts.providerMatches !== null || research.counts.retrievedRecords !== null ||
      !Array.isArray(research.queryContexts) || !Array.isArray(research.records) || research.records.length !== items.length) throw invalid();
  const ids = new Set<string>();
  const sourceRuns = new Set<string>();
  const actual = Object.fromEntries(phases.map(phase => [phase, 0]));
  items.forEach((item, index) => {
    const record: unknown = (research.records as unknown[])[index];
    if (!object(item) || typeof item.searchId !== "string" || !item.searchId || ids.has(item.searchId) ||
        item.rank !== index + 1 || !phases.includes(item.phase as typeof phases[number]) ||
        !(item.acquisitionState === null || typeof item.acquisitionState === "string") ||
        !(item.childBatchId === null || typeof item.childBatchId === "string") ||
        !(item.originalHash === null || typeof item.originalHash === "string") || typeof item.reason !== "string" ||
        !(item.availabilityReason === null || typeof item.availabilityReason === "string") ||
        item.file !== null || item.original !== null ||
        item.availability !== (item.acquisitionState === "acquired" ? "not_revalidated" : "not_acquired") ||
        !object(record) || record.searchId !== item.searchId || !Array.isArray(record.originals) ||
        record.originals.some(original => !object(original) || original.availability !== "not_revalidated")) throw invalid();
    ids.add(item.searchId);
    if (expected.scopeKind) {
      if (!Array.isArray(record.runIds) || !record.runIds.length || new Set(record.runIds).size !== record.runIds.length ||
          record.runIds.some(id => typeof id !== "string" || !expected.sourceRunIDs?.includes(id))) throw invalid();
      record.runIds.forEach(id => sourceRuns.add(id as string));
    }
    actual[String(item.phase)]++;
  });
  if (phases.some(phase => actual[phase] !== plan.counts[phase])) throw invalid();
  if (expected.scopeKind && sourceRuns.size !== expected.sourceRunIDs?.length) throw invalid();
}

export async function exportPlan(library: string, identity: ExportIdentity, format: PlanExportFormat,
  generation: number, signal: AbortSignal, transfer: TransferOptions = {}) {
  const current = () => {
    if (signal.aborted || generation !== sessionGeneration()) throw new Error("Plan export context changed. No file was saved.");
  };
  current();
  const expected = { ...identity, sourceRunIDs: identity.sourceRunIDs && [...identity.sourceRunIDs] };
  if (!library || !expected.planID || (expected.scopeKind ? expected.runID !== "" || !expected.sourceRunIDs?.length : !expected.runID) || !Number.isInteger(expected.selectedCount) ||
      expected.selectedCount < 1 || expected.selectedCount > 100 || !["json", "zip"].includes(format)) throw invalid();
  const blob = await requestBlob(`/api/libraries/${encodeURIComponent(library)}/plans/${encodeURIComponent(expected.planID)}/exports`,
    { method: "POST", body: JSON.stringify({ format }), signal }, generation,
    { ...transfer, maxBytes: (format === "json" ? 8 : 37) * 1024 * 1024 });
  current();
  const mime = blob.type.split(";")[0].trim().toLowerCase();
  if (mime !== (format === "json" ? "application/json" : "application/zip") ||
      blob.size > (format === "json" ? 8 : 37) * 1024 * 1024) throw invalid();
  if (format === "json") {
    const bytes = await blob.arrayBuffer(); current();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
    validatePlanMetadata(value, expected);
  } else {
    // Container signature only: archive integrity/manifest qualification belongs
    // to the native serializer. Never fabricate included counts from plan state.
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer()); current();
    if (signature.join(",") !== "80,75,3,4") throw invalid();
  }
  current();
  return { blob, filename: format === "json" ? "litradock-plan.json" : "litradock-plan-originals.zip" };
}

export function exportFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "This export exceeded a size or time limit, or saved data is inconsistent. No partial file was saved. Try plan metadata JSON, or open a child batch for smaller bundles and individual originals.";
    if (error.status === 429) return `Another ZIP is being prepared. ${error.retryAfter === undefined ? "Wait before trying again explicitly" : `Wait at least ${error.retryAfter} seconds before trying again explicitly`}, or export metadata JSON. No automatic retry was started.`;
    if (error.status === 404) return "This saved plan is unavailable. Refresh saved plans or choose another plan.";
  }
  return `${error instanceof Error ? error.message : "Export unavailable."} No automatic retry was started. Metadata JSON and existing child or individual downloads remain alternatives.`;
}
