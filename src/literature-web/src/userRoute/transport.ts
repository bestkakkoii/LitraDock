import { CredentialMode, credentialsVersion, providerKey, subscribeCredentials } from "./credentials";
import { markSourceStarted, retainSourceCooldown } from "./scheduler";

export type Descriptor = {
  captureSegment?: number;
  runID: string; attemptID: string; revision: number; stage: "esearch" | "efetch";
  parameters: Record<string, string>; credentialMode: CredentialMode; maxBytes: number;
  expiresAt: string; fresh: boolean; state: "running" | "completed" | "failed" | "interrupted";
};
export type FailureCode = "rate_limited" | "request_rejected" | "network_unavailable" | "provider_unavailable" | "invalid_response";
const failureMessages: Record<FailureCode, string> = {
  rate_limited: "NCBI limited this browser request. Your institution network or personal key may be shared; other users are not assumed to have failed.",
  request_rejected: "NCBI rejected the request or personal key. Check it in NCBI; no alternate credential or server route was used.",
  network_unavailable: "This browser could not read NCBI. Check connectivity; browser policy or source unavailability may also be responsible. A provider-wide outage is not established.",
  provider_unavailable: "NCBI returned a temporary failure to this browser. Saved research remains available.",
  invalid_response: "NCBI did not return a supported bounded XML response. No metadata was fabricated.",
};
export class SourceFailure extends Error {
  constructor(readonly code: FailureCode) { super(failureMessages[code]); this.name = "SourceFailure"; }
}
export function validateDescriptor(value: Descriptor, run: string): Descriptor {
  const p = value?.parameters;
  const common = ["db", "retmode", "tool", "email"];
  const keys = value?.stage === "esearch" ? [...common, "term", "retmax", "retstart", "sort"] : [...common, "id"];
  if (!value || value.runID !== run || !/^RUN-[0-9a-f]{32}$/.test(run) || !/^[0-9a-f-]{36}$/.test(value.attemptID) ||
    !Number.isSafeInteger(value.revision) || value.revision < 2 || !["esearch", "efetch"].includes(value.stage) ||
    !["unkeyed", "personal_key"].includes(value.credentialMode) || value.maxBytes !== 8 * 1024 * 1024 ||
    !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.fresh !== "boolean" ||
    !["running", "completed", "failed", "interrupted"].includes(value.state) || !p ||
    Object.keys(p).some(key => !keys.includes(key)) || Object.values(p).some(v => typeof v !== "string" || v.length > 20000) ||
    p.db !== "pubmed" || p.retmode !== "xml" || p.tool !== "LitraDock" ||
    (value.captureSegment !== undefined && (value.stage !== "esearch" || !Number.isSafeInteger(value.captureSegment) || value.captureSegment < 1 || value.captureSegment > 1024)) ||
    (value.stage === "esearch" && (!p.term || p.retmax !== (value.captureSegment === undefined ? "1000" : "10000") || p.retstart !== "0" || p.sort !== "relevance")) ||
    (value.stage === "efetch" && (!/^\d{1,20}(,\d{1,20}){0,99}$/.test(p.id ?? "") || new Set(p.id.split(",")).size !== p.id.split(",").length)))
    throw new Error("The source request descriptor was invalid; no provider request was sent.");
  return value;
}
export function retryCooldown(value: string | null): number {
  const ms = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(86400000, Math.max(60000, ms)) : 60000;
}
export async function fetchPubMed(descriptor: Descriptor, signal: AbortSignal): Promise<Uint8Array> {
  const d = validateDescriptor(descriptor, descriptor.runID);
  if (!d.fresh || d.state !== "running" || Date.parse(d.expiresAt) <= Date.now()) throw new Error("This source attempt is not fresh. Check saved progress; no request was repeated.");
  const body = new URLSearchParams(d.parameters);
  const key = providerKey(d.credentialMode);
  if (key) body.set("api_key", key);
  const version = credentialsVersion();
  const cancel = new AbortController();
  const retire = subscribeCredentials(() => cancel.abort());
  const timeout = setTimeout(() => cancel.abort(), 30000);
  const combined = AbortSignal.any([signal, cancel.signal]);
  const current = () => { combined.throwIfAborted(); if (credentialsVersion() !== version) throw new DOMException("Credentials changed", "AbortError"); };
  let response: Response | undefined;
  try {
    current();
    markSourceStarted();
    response = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${d.stage}.fcgi`, {
      method: "POST", body, mode: "cors", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: combined,
    });
    body.delete("api_key"); current();
    if (!response.ok) {
      if (response.status === 429) {
        retainSourceCooldown(retryCooldown(response.headers.get("Retry-After")));
        throw new SourceFailure("rate_limited");
      }
      throw new SourceFailure([400, 401, 403].includes(response.status) ? "request_rejected" : response.status >= 500 ? "provider_unavailable" : "invalid_response");
    }
    if (!["text/xml", "application/xml"].includes((response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase()) || !response.body)
      throw new SourceFailure("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const part = await reader.read(); current();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > d.maxBytes) throw new SourceFailure("invalid_response");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!total) throw new SourceFailure("invalid_response");
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SourceFailure("invalid_response"); }
    return bytes;
  } catch (error) {
    if (signal.aborted || version !== credentialsVersion()) throw new DOMException("Source request cancelled", "AbortError");
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure("network_unavailable");
  } finally {
    body.delete("api_key"); clearTimeout(timeout); retire();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
