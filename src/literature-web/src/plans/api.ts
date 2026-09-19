import { Article, SourceOutcome, request } from "../api";
import { SavedMember } from "./basket";

export const phases = ["waiting", "queued", "running", "completed", "held", "retry", "paused", "cancelled"] as const;
export type Phase = typeof phases[number];
export type PlanAction = "pause" | "resume" | "cancel" | "retry";
export type PlanSummary = {
  scopeKind?: "saved_set" | "saved_snapshot";
  sourceRunIDs?: string[];
  requestedFormat?: "xml" | "pdf";
  planID: string; runID: string; state: string; selectedCount: number;
  createdAt: string; updatedAt: string; revision: number; allowedActions: string[];
  counts: Record<Phase, number>;
  admission: { admittedCount: number; waitingCount: number; blockedReasonCode: string; reason: string; retryAfter: string | null };
  retryEligibleCount: number;
};
export type PlanItem = {
  sourceOutcome?: SourceOutcome;
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
  { requestID: string; scopeKind: "saved_set"; members: SavedMember[]; format: "xml" | "pdf" } |
  { requestID: string; scopeKind: "saved_snapshot"; members: SavedMember[]; format: "pdf" };
export type ControlPlan = { requestID: string; expectedRevision: number; value: PlanAction };
export type Receipt = { planID: string; revision: number; state: string; selectedCount?: number; affectedCount?: number };
const receiptError = () => new Error("The server receipt was not confirmed. Retry only the same submission to check its outcome.");
function receiptObject(value: unknown): asserts value is Receipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !("planID" in value) || typeof value.planID !== "string" || !/^PLN-[0-9a-f]{32}$/.test(value.planID)) throw receiptError();
}
export function validateCreateReceipt(value: unknown, body: CreatePlan): Receipt {
  receiptObject(value);
  const count = "members" in body ? body.members.length : body.searchIDs.length;
  const snapshot = "scopeKind" in body && body.scopeKind === "saved_snapshot";
  if (value.revision !== 1 || value.state !== (snapshot ? "saved_snapshot" : "active") || value.selectedCount !== count ||
    value.affectedCount !== 0) throw receiptError();
  return value;
}
export function validateControlReceipt(value: unknown, planID: string, selectedCount?: number): Receipt {
  receiptObject(value);
  if (value.planID !== planID || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    !["active", "paused", "cancelled", "complete", "partial"].includes(value.state) || !Number.isSafeInteger(value.affectedCount) || value.affectedCount! < 0 ||
    (value.selectedCount !== undefined && (!Number.isSafeInteger(value.selectedCount) || value.selectedCount < 1 ||
      value.selectedCount > 100 || (selectedCount !== undefined && value.selectedCount !== selectedCount)))) throw receiptError();
  return value;
}

export function validateSummary(plan: PlanSummary) {
  if (!plan || !plan.planID || !Number.isInteger(plan.revision) || plan.revision < 1 ||
    !Number.isInteger(plan.selectedCount) || plan.selectedCount < 1 || plan.selectedCount > 100 ||
    !Array.isArray(plan.allowedActions) || !plan.counts || !plan.admission ||
    phases.some(phase => !Number.isInteger(plan.counts[phase]) || plan.counts[phase] < 0) ||
    phases.reduce((total, phase) => total + plan.counts[phase], 0) !== plan.selectedCount)
    throw new Error("Plan status is unavailable: invalid server counts. Refresh to check again.");
  if (plan.scopeKind && (plan.runID !== "" || !Array.isArray(plan.sourceRunIDs) || !plan.sourceRunIDs.length ||
    plan.sourceRunIDs.some(id => typeof id !== "string" || !id) || new Set(plan.sourceRunIDs).size !== plan.sourceRunIDs.length))
    throw new Error("Saved-set provenance is unavailable. Refresh to check again.");
  if ((plan.scopeKind === "saved_snapshot" || plan.state === "saved_snapshot") &&
    (plan.scopeKind !== "saved_snapshot" || plan.state !== "saved_snapshot" || plan.allowedActions.length ||
      plan.admission.admittedCount !== 0 || plan.admission.waitingCount !== 0 || plan.retryEligibleCount !== 0 ||
      ["waiting", "queued", "running", "paused", "cancelled"].some(phase => plan.counts[phase as Phase] !== 0)))
    throw new Error("Snapshot status is inconsistent. No acquisition action is available.");
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
  if (page.plan.scopeKind === "saved_snapshot" && page.items.some(item => item.childBatchID !== null || item.retryEligible))
    throw new Error("Snapshot status contains unexpected processing actions.");
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
    async create(body: CreatePlan, signal: AbortSignal) {
      return validateCreateReceipt(await request<unknown>(base, { method: "POST", body: JSON.stringify(body), signal }, generation), body);
    },
    async control(id: string, body: ControlPlan, signal: AbortSignal, selectedCount?: number) {
      return validateControlReceipt(await request<unknown>(`${base}/${encodeURIComponent(id)}/control`, { method: "POST", body: JSON.stringify(body), signal }, generation), id, selectedCount);
    },
  };
}
