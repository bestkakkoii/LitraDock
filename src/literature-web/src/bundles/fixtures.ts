// SYNTHETIC test-only data generator; never imported by product modules.
export const fixturePlan = { planID: `PLN-${"1".repeat(32)}`, runID: "SYNTHETIC-R1", selectedCount: 3 };
export function fixtureDocument(files: Array<{ bytes: number; sha256: string; zipBytes: number; zipHash: string }> = []) {
  const id = `BND-${"a".repeat(32)}`;
  const parts = files.map((f, n) => ({ number: n + 1, filename: `litradock-originals-part-${String(n + 1).padStart(3, "0")}.zip`, bytes: f.zipBytes, sha256: f.zipHash, originalBytes: f.bytes,
    files: [{ file: `originals/${f.sha256}.xml`, sha256: f.sha256, format: "XML", bytes: f.bytes, searchIDs: [`SYNTHETIC-S${n}`] }] }));
  const records = [0, 1, 2].map(n => ({ searchId: `SYNTHETIC-S${n}`, runIds: [fixturePlan.runID],
    publication: { title: `SYNTHETIC 中文 α "MeSH" AND (long Boolean query OR multilingual)\nrecord ${n}` },
    identifiers: { pmid: `000${n}`, doi: "10.123/α", pmcid: null }, originals: [],
    sourceLinks: { pubmed: `https://pubmed.ncbi.nlm.nih.gov/${n + 1}/`, pmc: null, doi: null, doiLinkState: "unresolved" } }));
  const items = records.map((r, n) => ({ searchId: r.searchId, rank: n + 1, phase: n < files.length ? "completed" : "held", childBatchId: null,
    acquisitionState: n < files.length ? "acquired" : "unavailable", reason: n < files.length ? "" : "SYNTHETIC rights held; open source links",
    availability: n < files.length ? "included" : "not_acquired", availabilityReason: n < files.length ? null : "SYNTHETIC rights held; open source links",
    originalHash: files[n]?.sha256 ?? null, file: parts[n]?.files[0].file ?? null,
    original: n < files.length ? { kind: "source_original", format: "XML", mediaType: "application/xml", sha256: files[n].sha256, bytes: files[n].bytes, availability: "included" } : null }));
  return { schema: "litradock.bundle", schemaVersion: 1, snapshotID: id, createdAt: "2026-09-13T00:00:00Z", expiresAt: "2026-09-14T00:00:00Z", planID: fixturePlan.planID, parts,
    manifest: { schema: "litradock.plan-export", schemaVersion: 1, type: "document", originalsRevalidated: true, generatedAt: "2026-09-13T00:00:00Z", plan: fixturePlan,
      counts: { members: 3, includedRecords: files.length, unresolvedRecords: 3 - files.length, uniqueOriginals: files.length, originalBytes: files.reduce((n, f) => n + f.bytes, 0) }, items,
      research: { schema: "litradock.research-export", schemaVersion: 1, type: "document", scope: { kind: "plan", planId: fixturePlan.planID, runId: null, batchId: null, selection: "all_saved_scope" },
        counts: { exportedRecords: 3, scopeRecords: 3, providerMatches: null, retrievedRecords: null }, queryContexts: [], records } } };
}
