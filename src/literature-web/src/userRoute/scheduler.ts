import { CredentialMode } from "./credentials";

const pacingKey = "litradock.pubmed.pacing.v1";
const lockName = "litradock.pubmed.requests.v1";
export const minimumGap = 1200;
type Pacing = { lastStart: number; cooldownUntil: number };

function pacing(): Pacing {
  const raw = localStorage.getItem(pacingKey);
  if (raw == null) return { lastStart: 0, cooldownUntil: 0 };
  const value = JSON.parse(raw) as Pacing;
  if (!value || ![value.lastStart, value.cooldownUntil].every(n => Number.isSafeInteger(n) && n >= 0))
    throw new Error("Browser source pacing state is unavailable. Saved research remains usable.");
  return value;
}
function save(value: Pacing) { localStorage.setItem(pacingKey, JSON.stringify(value)); }
// Admission can be slow. Anchor the next spacing interval to the actual source
// invocation, while the caller still owns the profile's exclusive lock.
export function markSourceStarted() { save({ ...pacing(), lastStart: Date.now() }); }
export function browserRouteSupport(): string {
  if (!globalThis.isSecureContext || !navigator.locks?.request || !globalThis.ReadableStream || !crypto.randomUUID || !AbortSignal.any)
    return "Direct PubMed access requires HTTPS and a browser with Web Locks, streaming Fetch and AbortSignal.any. Saved research remains available; this browser will not use the server as a fallback.";
  // Capability checks run during rendering, outside the request lock. A separate
  // disposable key must never overwrite another tab's authoritative timing.
  try {
    pacing();
    const probe = "litradock.pubmed.storage-check";
    localStorage.setItem(probe, "1"); localStorage.removeItem(probe);
  } catch { return "Browser storage must be available for source pacing. Saved research remains available."; }
  return "";
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(0, ms));
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function withSourceSlot<T>(_mode: CredentialMode, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const unsupported = browserRouteSupport();
  if (unsupported) throw new Error(unsupported);
  return navigator.locks.request(lockName, { mode: "exclusive", signal }, async () => {
    const state = pacing();
    const due = Math.max(state.lastStart + minimumGap, state.cooldownUntil);
    if (due - Date.now() > 120_000) throw new Error("This browser network is cooling down. Retry later; saved research remains available.");
    await abortableDelay(due - Date.now(), signal);
    signal.throwIfAborted();
    save({ ...state, lastStart: Date.now() });
    return work();
  });
}
// Called while holding the source lock. This contains times only, never keys,
// hashes of keys, account identifiers, queries or device/network fingerprints.
export function retainSourceCooldown(milliseconds: number) {
  const state = pacing();
  save({ ...state, cooldownUntil: Math.max(state.cooldownUntil, Date.now() + milliseconds) });
}
