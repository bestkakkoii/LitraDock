import { request } from "../api";
import { CredentialMode } from "../userRoute/credentials";

export const states = ["queued", "running", "ready", "exhausted", "window_limited", "cancelled", "failed", "rate_wait", "expired", "unavailable"] as const;
export type ContinuationState = typeof states[number];
export type Continuation = {
  execution?: "user_browser"; credentialMode?: CredentialMode; canStart?: boolean; canRecover?: boolean;
  attemptID?: string; attemptExpiresAt?: string | null;
  runID: string; revision: number; state: ContinuationState; windowLimit: number;
  windowCount: number; processedCount: number; savedCount: number; missingCount: number;
  providerTotal: number; pageSize: number; attempts: number; canContinue: boolean;
  canRetry: boolean; canCancel: boolean; reason: string; snapshotAt: string | null;
  missingPMIDs?: string[] | null;
};
export type Action = "continue" | "retry" | "cancel";
export const validRunID = (id: unknown): id is string => typeof id === "string" && /^RUN-[0-9a-f]{32}$/.test(id);
export function validateReceipt(value: unknown, expected: string) {
  const receipt = value as { runID?: unknown; revision?: number; state?: ContinuationState } | null;
  if (!receipt || !validRunID(receipt.runID) || receipt.runID !== expected || !Number.isSafeInteger(receipt.revision) || receipt.revision! < 1 || !states.includes(receipt.state!))
    throw new Error("The continuation receipt was not confirmed. Retry only the same request.");
  return receipt;
}
export function validateContinuation(value: Continuation | null | undefined, runID: string): Continuation | null {
  if (value == null) return null;
  validateReceipt(value, runID);
  if (value.execution !== undefined && (value.execution !== "user_browser" || !["unkeyed", "personal_key"].includes(value.credentialMode ?? "") ||
    (value.canStart !== undefined && typeof value.canStart !== "boolean") || (value.canRecover !== undefined && typeof value.canRecover !== "boolean") ||
    (value.attemptID !== undefined && !/^[0-9a-f-]{36}$/.test(value.attemptID)) ||
    (value.attemptExpiresAt != null && !Number.isFinite(Date.parse(value.attemptExpiresAt)))))
    throw new Error("Browser source status is invalid; no request was admitted.");
  if (![value.windowCount, value.processedCount, value.savedCount, value.missingCount, value.providerTotal, value.attempts].every(n => Number.isSafeInteger(n) && n >= 0) ||
    value.windowLimit !== 1000 || value.windowCount > value.windowLimit || value.windowCount > value.providerTotal ||
    value.processedCount > value.windowCount || value.savedCount + value.missingCount !== value.processedCount ||
    !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100 || value.attempts > 3 ||
    [value.canContinue, value.canRetry, value.canCancel].some(v => typeof v !== "boolean") || typeof value.reason !== "string" ||
    (value.snapshotAt !== null && (typeof value.snapshotAt !== "string" || !Number.isFinite(Date.parse(value.snapshotAt)))) ||
    (value.missingPMIDs != null && (!Array.isArray(value.missingPMIDs) || value.missingPMIDs.length > value.missingCount ||
      new Set(value.missingPMIDs).size !== value.missingPMIDs.length || value.missingPMIDs.some(id => typeof id !== "string" || !/^[0-9]+$/.test(id)))))
    throw new Error("Search continuation status is invalid. Refresh saved status; no work was admitted.");
  return value;
}
export type SearchIntent = { query: string; limit: number; requestID: string; credentialMode?: CredentialMode };
export type ActionIntent = { requestID: string; revision: number; action: Action; credentialMode?: CredentialMode };
export async function submitSearch(library: string, body: SearchIntent, generation: number, signal: AbortSignal) {
  const value = await request<{ id?: unknown }>(`/api/libraries/${encodeURIComponent(library)}/search`, { method: "POST", body: JSON.stringify(body), signal }, generation);
  if (!validRunID(value?.id)) throw new Error("Search receipt was not confirmed. Retry only the same request.");
  return value.id;
}
export async function submitAction(library: string, runID: string, body: ActionIntent, generation: number, signal: AbortSignal) {
  const value = await request<unknown>(`/api/libraries/${encodeURIComponent(library)}/runs/${encodeURIComponent(runID)}/continuation`, { method: "POST", body: JSON.stringify(body), signal }, generation);
  validateReceipt(value, runID);
  return runID;
}
