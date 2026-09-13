// Synthetic, isolated test records; never imported by product code.
import { PlanPage, PlanSummary } from "./api";
export function summary(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return { planID: "PLN-00000000000000000000000000000001", runID: "synthetic-run", state: "active", selectedCount: 37,
    createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:01Z", revision: 3,
    allowedActions: ["pause", "cancel"], counts: { waiting: 27, queued: 4, running: 1, completed: 2, held: 1, retry: 2, paused: 0, cancelled: 0 },
    admission: { admittedCount: 10, waitingCount: 27, blockedReasonCode: "", reason: "", retryAfter: null }, retryEligibleCount: 2, ...overrides };
}
export function detail(overrides: Partial<PlanSummary> = {}): PlanPage {
  return { plan: summary(overrides), total: 37, offset: 0, limit: 25, nextPollAfterMs: 2000, policy: "synthetic-only",
    items: [{ searchID: "synthetic-search", rank: 1, childBatchID: "synthetic-batch", phase: "completed", acquisitionState: "acquired",
      reason: "Synthetic current policy denial", attempts: 1, retryEligible: false, downloadAvailable: false,
      article: { Title: "Synthetic <script> hostile α 中文", Pmid: "990000001", Pmcid: "PMC990000001", Doi: "10.0000/α", OriginalUri: "https://pubmed.ncbi.nlm.nih.gov/990000001/" },
      original_hash: "a".repeat(64), bytes: 123, rights_uri: "", source_uri: "", repository_stamp: "", format: "XML", version: "repository snapshot" }] };
}
