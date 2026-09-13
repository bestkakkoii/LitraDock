// SYNTHETIC metadata only; never imported by production code.
export function exportFixture(planID = "P1", count = 3) {
  const items = Array.from({ length: count }, (_, index) => ({ searchId: `S${index}`, rank: index + 1,
    childBatchId: "B1", acquisitionState: index === 0 ? "acquired" : "unavailable",
    phase: index === 0 ? "completed" : "held", reason: "SYNTHETIC outcome",
    originalHash: null, availability: index === 0 ? "not_revalidated" : "not_acquired",
    availabilityReason: "SYNTHETIC metadata only", file: null, original: null }));
  return {
    schema: "litradock.plan-export", schemaVersion: 1, type: "document", generatedAt: "2026-09-13T00:00:00Z",
    plan: { planID, runID: "R1", revision: 2, selectedCount: count, state: "complete", allowedActions: [],
      counts: { waiting: 0, queued: 0, running: 0, completed: count ? 1 : 0, held: Math.max(0, count - 1), retry: 0, paused: 0, cancelled: 0 }, admission: {} },
    originalsRevalidated: false,
    counts: { members: count, includedRecords: null, unresolvedRecords: null, uniqueOriginals: null, originalBytes: null },
    items,
    research: { schema: "litradock.research-export", schemaVersion: 1, type: "document",
      scope: { kind: "plan", planId: planID, runId: null, batchId: null, selection: "all_saved_scope" },
      counts: { exportedRecords: count, scopeRecords: count, providerMatches: null, retrievedRecords: null }, queryContexts: [],
      records: items.map(item => ({ searchId: item.searchId, identifiers: { pmid: "000123", pmcid: null, doi: "10.123/α" },
        publication: { title: 'SYNTHETIC "中文"\nα', abstract: null }, originals: [] })) },
  };
}
