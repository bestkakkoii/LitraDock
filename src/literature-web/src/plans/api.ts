import { Article, request } from "../api";
import { SavedMember } from "./basket";

export const phases = ["waiting", "queued", "running", "completed", "held", "retry", "paused", "cancelled"] as const;
export type Phase = typeof phases[number];
export type PlanAction = "pause" | "resume" | "cancel" | "retry";
export type PlanSummary = {
  scopeKind?: "saved_set";
  sourceRunIDs?: string[];
  requestedFormat?: "xml" | "pdf";
  planID: string; runID: string; state: string; selectedCount: number;
  createdAt: string; updatedAt: string; revision: number; allowedActions: string[];
  counts: Record<Phase, number>;
  admission: { admittedCount: number; waitingCount: number; blockedReasonCode: string; reason: string; retryAfter: string | null };
  retryEligibleCount: number;
};
export type PlanItem = {
  runIDs?: string[];
  mediaType?: string; depositVersion?: string; depositType?: string;
  searchID: string; rank: number; childBatchID: string | null; phase: Phase;
  acquisitionState: string | null; reason: string; attempts: number;
  retryEligible: boolean; downloadAvailable: boolean; article: Article;
  original_hash: string; bytes: number; rights_uri: string; source_uri: string;
  repository_stamp: string; format: string; version: string;
};
export type PlanPage = { plan: PlanSummary; items: PlanItem[]; total: number; offset: number; limit: number; nextPollAfterMs: number; policy: string };
export type PlanCatalog = { plans: PlanSummary[]; total: number; offset: number; limit: number };
export type CreatePlan = { requestID: string; runID: string; searchIDs: string[]; format?: "xml" | "pdf" } |
  { requestID: string; scopeKind: "saved_set"; members: SavedMember[]; format: "xml" | "pdf" };
export type ControlPlan = { requestID: string; expectedRevision: number; value: PlanAction };
export type Receipt = { planID: string; revision: number; state: string; selectedCount?: number; affectedCount?: number };

export function validateSummary(plan: PlanSummary) {
  if (!plan || !plan.planID || !Number.isInteger(plan.revision) || plan.revision < 1 ||
    !Number.isInteger(plan.selectedCount) || plan.selectedCount < 1 || plan.selectedCount > 100 ||
    !Array.isArray(plan.allowedActions) || !plan.counts || !plan.admission ||
    phases.some(phase => !Number.isInteger(plan.counts[phase]) || plan.counts[phase] < 0) ||
    phases.reduce((total, phase) => total + plan.counts[phase], 0) !== plan.selectedCount)
    throw new Error("Plan status is unavailable: invalid server counts. Refresh to check again.");
  if (plan.scopeKind === "saved_set" && (plan.runID !== "" || !Array.isArray(plan.sourceRunIDs) || !plan.sourceRunIDs.length ||
    plan.sourceRunIDs.some(id => typeof id !== "string" || !id) || new Set(plan.sourceRunIDs).size !== plan.sourceRunIDs.length))
    throw new Error("Saved-set provenance is unavailable. Refresh to check again.");
}
export function validatePage(page: PlanPage): PlanPage {
  validateSummary(page.plan);
  if (page.total !== page.plan.selectedCount || !Array.isArray(page.items) ||
    !Number.isInteger(page.offset) || page.offset < 0 || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100 ||
    page.items.length > page.limit || page.items.length > page.total ||
    new Set(page.items.map(item => item.searchID)).size !== page.items.length ||
    page.items.some(item => !item.searchID || !phases.includes(item.phase) || typeof item.downloadAvailable !== "boolean") ||
    !Number.isFinite(page.nextPollAfterMs) || page.nextPollAfterMs < 0)
    throw new Error("Plan status is unavailable: invalid server response.");
  return page;
}
export function planApi(library: string, generation: number) {
  const base = `/api/libraries/${encodeURIComponent(library)}/plans`;
  return {
    async catalog(offset: number, signal: AbortSignal): Promise<PlanCatalog> {
      const result = await request<PlanCatalog>(`${base}?offset=${offset}&limit=25`, { signal }, generation);
      result.plans.forEach(validateSummary);
      return result;
    },
    async detail(id: string, offset: number, signal: AbortSignal): Promise<PlanPage> {
      const page = validatePage(await request<PlanPage>(`${base}/${encodeURIComponent(id)}?offset=${offset}&limit=25`, { signal }, generation));
      if (page.plan.planID !== id || page.offset !== offset) throw new Error("Plan response did not match the requested page.");
      return page;
    },
    create(body: CreatePlan, signal: AbortSignal) {
      return request<Receipt>(base, { method: "POST", body: JSON.stringify(body), signal }, generation);
    },
    control(id: string, body: ControlPlan, signal: AbortSignal) {
      return request<Receipt>(`${base}/${encodeURIComponent(id)}/control`, { method: "POST", body: JSON.stringify(body), signal }, generation);
    },
  };
}
