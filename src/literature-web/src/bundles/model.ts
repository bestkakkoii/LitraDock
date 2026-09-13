import { ExportIdentity } from "../plans/exports";

export const MiB = 1024 * 1024;
export const snapshotPattern = /^BND-[0-9a-f]{32}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const invalid = () => new Error("The saved download snapshot is invalid or does not match this plan. Refresh the saved snapshots; no file was saved.");
export type BundleFile = { file: string; sha256: string; format: string; bytes: number; searchIDs: string[] };
export type BundlePart = { number: number; filename: string; bytes: number; sha256: string; originalBytes: number; files: BundleFile[] };
export type BundleSummary = { snapshotID: string; planID: string; createdAt: string; expiresAt: string; partCount: number; members: number; originalBytes: number };
export type BundleDocument = {
  schema: "litradock.bundle"; schemaVersion: 1; snapshotID: string; planID: string; createdAt: string; expiresAt: string;
  manifest: {
    counts: { members: number; includedRecords: number; unresolvedRecords: number; uniqueOriginals: number; originalBytes: number };
    items: Array<{ searchId: string; rank: number; availability: string; availabilityReason: string | null; reason: string; file: string | null; original: { sha256: string; format: string; bytes: number } | null }>;
    research: { records: Array<{ searchId: string; publication?: { title?: string }; sourceLinks?: Record<string, unknown> }> };
  };
  parts: BundlePart[];
};

export function validateList(value: unknown, planID: string): BundleSummary[] {
  if (!object(value) || !Array.isArray(value.items) || !integer(value.total, 0, 20) || value.total !== value.items.length) throw invalid();
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!object(item) || !snapshotPattern.test(item.snapshotID) || seen.has(item.snapshotID) || item.planID !== planID ||
        !date(item.createdAt) || !date(item.expiresAt) || !integer(item.partCount, 0, 100) || !integer(item.members, 1, 100) || !integer(item.originalBytes, 0, 128 * MiB)) throw invalid();
    seen.add(item.snapshotID);
  }
  return value.items as BundleSummary[];
}

// Validate the complete member/file association graph before trusting filenames,
// transfer lengths, hashes or the preparation receipt. Do not reserialize bytes.
export function validateDocument(value: unknown, expected: ExportIdentity, snapshotID?: string): BundleDocument {
  if (!object(value) || value.schema !== "litradock.bundle" || value.schemaVersion !== 1 || !snapshotPattern.test(value.snapshotID) ||
      (snapshotID && value.snapshotID !== snapshotID) || value.planID !== expected.planID || !date(value.createdAt) || !date(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) || !object(value.manifest) || !Array.isArray(value.parts) || value.parts.length > 100) throw invalid();
  const m = value.manifest, c = m.counts, r = m.research;
  if (m.schema !== "litradock.plan-export" || m.schemaVersion !== 1 || m.type !== "document" || m.originalsRevalidated !== true ||
      !object(m.plan) || m.plan.planID !== expected.planID || m.plan.runID !== expected.runID || m.plan.selectedCount !== expected.selectedCount ||
      m.plan.scopeKind !== expected.scopeKind || (expected.scopeKind === "saved_set" && JSON.stringify(m.plan.sourceRunIDs) !== JSON.stringify(expected.sourceRunIDs)) ||
      !object(c) || c.members !== expected.selectedCount || !integer(c.members, 1, 100) || !integer(c.includedRecords, 0, c.members) ||
      c.unresolvedRecords !== c.members - c.includedRecords || !integer(c.uniqueOriginals, 0, c.includedRecords) || !integer(c.originalBytes, 0, 128 * MiB) ||
      !Array.isArray(m.items) || m.items.length !== c.members || !object(r) || r.schema !== "litradock.research-export" || r.schemaVersion !== 1 || r.type !== "document" ||
      !object(r.scope) || r.scope.kind !== "plan" || r.scope.planId !== expected.planID || r.scope.selection !== "all_saved_scope" || r.scope.runId !== null || r.scope.batchId !== null ||
      !object(r.counts) || r.counts.exportedRecords !== c.members || r.counts.scopeRecords !== c.members || r.counts.providerMatches !== null || r.counts.retrievedRecords !== null ||
      !Array.isArray(r.queryContexts) || !Array.isArray(r.records) || r.records.length !== c.members) throw invalid();
  const members = new Map<string, Record<string, any>>();
  let included = 0;
  m.items.forEach((item: unknown, index: number) => {
    if (!object(item) || typeof item.searchId !== "string" || !item.searchId || members.has(item.searchId) || item.rank !== index + 1 ||
        !object(r.records[index]) || r.records[index].searchId !== item.searchId || !object(r.records[index].publication) ||
        !(r.records[index].publication.title === null || typeof r.records[index].publication.title === "string") ||
        !object(r.records[index].sourceLinks) || Object.values(r.records[index].sourceLinks).some(v => v !== null && typeof v !== "string") || typeof item.reason !== "string" ||
        !(item.availabilityReason === null || typeof item.availabilityReason === "string")) throw invalid();
    if (item.availability === "included") {
      if (typeof item.file !== "string" || !object(item.original) || !hashPattern.test(item.original.sha256) ||
          !["pdf", "xml"].includes(String(item.original.format).toLowerCase()) || !integer(item.original.bytes, 1, 8 * MiB)) throw invalid();
      included++;
    } else if (!["unavailable", "not_acquired"].includes(item.availability) || item.file !== null || item.original !== null || !item.availabilityReason) throw invalid();
    members.set(item.searchId, item);
  });
  if (included !== c.includedRecords) throw invalid();
  const files = new Set<string>(), associated = new Set<string>();
  let originalBytes = 0;
  value.parts.forEach((part: unknown, index: number) => {
    if (!object(part) || part.number !== index + 1 || typeof part.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.zip$/.test(part.filename) ||
        !integer(part.bytes, 1, 17 * MiB) || !hashPattern.test(part.sha256) || !integer(part.originalBytes, 1, 8 * MiB) || !Array.isArray(part.files) || !part.files.length) throw invalid();
    let size = 0;
    for (const f of part.files) {
      if (!object(f) || !hashPattern.test(f.sha256) || !["pdf", "xml"].includes(String(f.format).toLowerCase()) ||
          f.file !== `originals/${f.sha256}.${String(f.format).toLowerCase()}` || files.has(f.file) || !integer(f.bytes, 1, 8 * MiB) || !Array.isArray(f.searchIDs) || !f.searchIDs.length) throw invalid();
      for (const id of f.searchIDs) {
        const item = members.get(id);
        if (!item || associated.has(id) || item.availability !== "included" || item.file !== f.file || item.original.sha256 !== f.sha256 || item.original.bytes !== f.bytes ||
            String(item.original.format).toLowerCase() !== String(f.format).toLowerCase()) throw invalid();
        associated.add(id);
      }
      files.add(f.file); size += f.bytes;
    }
    if (size !== part.originalBytes) throw invalid();
    originalBytes += size;
  });
  if (files.size !== c.uniqueOriginals || associated.size !== c.includedRecords || originalBytes !== c.originalBytes) throw invalid();
  return value as BundleDocument;
}
