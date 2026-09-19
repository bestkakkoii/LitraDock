import { readTransfer, TransferOptions } from "./transfer";
import { Continuation, validateContinuation } from "./continuation/api";
import { clearPubMedKey } from "./userRoute/credentials";
export type Session = { csrf: string };
export type SourceOutcome = {
  status: string; label: string; detail: string; nextAction: string;
  requestedFormat: string; evidence: string; observedAt: string | null;
  retryEligible: boolean; batchId: string | null;
  sourceLinks: { pubmed: string | null; pmc: string | null; doi: string | null; doiLinkState: string | null };
};
export type Library = { library_id: string; name: string };
export type Run = {
  run_id: string;
  input: string;
  total: number;
  fetched: number;
  state: string;
  reason?: string;
};
export type Article = Record<string, unknown> & {
  SourceOutcome?: SourceOutcome;
  SearchId?: string;
  Title?: string;
  Authors?: string;
  Year?: string | number;
  Journal?: string;
  Pmid?: string;
  Pmcid?: string;
  Doi?: string;
  DoiLinkState?: string;
  OriginalUri?: string;
  PmcUri?: string;
  DoiUri?: string;
};
export type RunPage = {
  continuation?: Continuation | null;
  records: Article[];
  run: Run;
  total: number;
  offset: number;
  limit: number;
};
export type SavedBatch = { batch_id: string; state: string };
export type LibraryPage = {
  batches?: SavedBatch[];
  runs: Run[];
  totals: { runs: number; batches?: number };
  offset: number;
  limit: number;
};
export type ServiceInfo = {
	stagedQueryEnabled?: boolean;
	userRouteEnabled?: boolean;
  durableSelectionEnabled?: boolean;
  selectionWriteEnabled?: boolean;
  selectionRecordLimit?: number;
  searchContinuationEnabled?: boolean;
  searchWindowLimit?: number;
  savedSetEnabled?: boolean;
  pdfEnabled?: boolean;
  pdfPolicySummary?: string;
  planEnabled?: boolean;
  planSelectionLimit?: number;
  planGroupLimit?: number;
  searchEnabled?: boolean;
  contact?: string;
  expiresAt?: string;
  batchLimit?: number;
  acquisitionEnabled?: boolean;
  source?: string;
  operatorName?: string;
  retention?: string;
};
export type BatchItem = {
  sourceOutcome?: SourceOutcome;
  mediaType?: string;
  depositVersion?: string;
  depositType?: string;
  search_id: string;
  rank: number;
  state: string;
  reason?: string;
  attempts: number;
  original_hash?: string;
  rights_uri?: string;
  repository_stamp?: string;
  source_uri?: string;
  bytes?: number;
  article: Article;
  downloadAvailable: boolean;
  format?: string;
  version?: string;
};
export type BatchDetail = {
  requestedFormat?: "xml" | "pdf";
  batch: { batch_id: string; state: string; created_at: string; plan_id?: string | null };
  items: BatchItem[];
  total: number;
  counts: Record<string, number>;
  policy?: string;
};
export type MetadataExportScope = { runID?: string; batchID?: string; selection?: never } | {
  runID: string; batchID?: never; selection: "selected"; selectionRevision: number;
  selectedIDs: readonly string[]; savedCount: number;
};
export function metadataExportBody(scope: MetadataExportScope, format: string) {
  if (scope.selection !== "selected") return { ...scope, format };
  if (!scope.runID || scope.batchID || !["csv", "xlsx", "json", "jsonl"].includes(format) ||
      !Number.isSafeInteger(scope.selectionRevision) || scope.selectionRevision < 1 ||
      !Number.isSafeInteger(scope.savedCount) || scope.savedCount > 1000 ||
      scope.selectedIDs.length < 1 || scope.selectedIDs.length > scope.savedCount ||
      new Set(scope.selectedIDs).size !== scope.selectedIDs.length || scope.selectedIDs.some(id => !id))
    throw new Error("Select a supported saved-run scope before exporting.");
  return { RunID: scope.runID, Selection: "selected", SelectionRevision: scope.selectionRevision, Format: format };
}
export function validateMetadataResponse(scope: MetadataExportScope, response: Response) {
  if (scope.selection !== "selected") return;
  if (response.headers.get("X-LitraDock-Export-Scope") !== "selected_saved_records" ||
      response.headers.get("X-LitraDock-Selection-Revision") !== String(scope.selectionRevision) ||
      response.headers.get("X-LitraDock-Export-Count") !== String(scope.selectedIDs.length))
    throw new Error("The export did not match the selected saved scope. No file was saved; reload the selection.");
}
export function metadataFilename(scope: MetadataExportScope, format: string) {
  return scope.batchID ? `batch-${scope.batchID}.${format}` :
    scope.selection === "selected" ? `litradock-selected-${scope.runID}-r${scope.selectionRevision}.${format}` : `litradock-saved-${scope.runID}.${format}`;
}
let csrf = "";
let generation = 0;
const sessionListeners = new Set<() => void>();
export const sessionGeneration = () => generation;
export const onSessionInvalidated = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
};
export const clearSession = () => {
	clearPubMedKey();
  generation += 1;
  csrf = "";
  sessionListeners.forEach((listener) => listener());
};
export const setSession = (value: Session) => {
	clearPubMedKey();
  generation += 1;
  csrf = value.csrf;
};
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter?: number) {
    super(message);
    this.name = "ApiError";
  }
}
// Bounded advisory, never a retry scheduler. Ignore malformed, past or excessive
// Retry-After values rather than exposing arbitrary header text to the UI.
function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) :
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : undefined;
}
function assertRequestCurrent(expected: number, signal?: AbortSignal | null) {
  if (expected !== generation || signal?.aborted)
    throw new Error("Session changed; the previous request was discarded.");
}
async function discardBoundedError(response: Response, expected: number, signal: AbortSignal | null | undefined, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) { assertRequestCurrent(expected, signal); return; }
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read(); assertRequestCurrent(expected, signal);
      if (part.done) break;
      received += part.value.byteLength;
      if (received >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
    assertRequestCurrent(expected, signal);
  }
}
// Match the small server admission envelope. Reading the body owns the slot;
// queued requests revalidate their captured scope before any network effect.
let activeRequests = 0;
const requestWaiters: Array<() => void> = [];
function requestSlot(): (() => void) | Promise<() => void> {
  const release = () => {
    const next = requestWaiters.shift();
    if (next) next(); else activeRequests -= 1;
  };
  if (activeRequests < 2) { activeRequests += 1; return release; }
  if (requestWaiters.length >= 16) throw new Error("Too many pending requests. Wait for current work, then refresh.");
  return new Promise<() => void>(resolve => requestWaiters.push(() => resolve(release)));
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedGeneration = generation,
  maxBodyBytes?: number,
): Promise<T> {
  const slot = requestSlot();
  const release = typeof slot === "function" ? slot : await slot;
  try {
  assertRequestCurrent(expectedGeneration, init.signal);
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.body && csrf) headers.set("X-CSRF", csrf);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  assertRequestCurrent(expectedGeneration, init.signal);
  let text: string;
  if (maxBodyBytes !== undefined && !response.ok) {
    await discardBoundedError(response, expectedGeneration, init.signal, Math.min(maxBodyBytes, 64 * 1024));
    if (response.status === 401) { clearSession(); throw new ApiError(401, "Your session has expired. Please sign in again."); }
    throw new ApiError(response.status, `Request unavailable (HTTP ${response.status}).`);
  }
  if (maxBodyBytes === undefined) text = await response.text();
  else {
    const body = await readTransfer(response, init.signal, () => assertRequestCurrent(expectedGeneration, init.signal), { maxBytes: maxBodyBytes });
    text = await body.text();
  }
  assertRequestCurrent(expectedGeneration, init.signal);
  if (response.status === 401) {
    clearSession();
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String(data.error)
        : `Request unavailable (HTTP ${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return data as T;
  } finally { release(); }
}
export async function requestBlob(
  path: string,
  init: RequestInit = {},
  expectedGeneration = generation,
  transfer: TransferOptions & { maxErrorBytes?: number; validateResponse?: (response: Response) => void } = {},
): Promise<Blob> {
  const slot = requestSlot();
  const release = typeof slot === "function" ? slot : await slot;
  try {
  assertRequestCurrent(expectedGeneration, init.signal);
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.body && csrf) headers.set("X-CSRF", csrf);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  assertRequestCurrent(expectedGeneration, init.signal);
  if (!response.ok) {
    if (transfer.maxErrorBytes === undefined) await response.text();
    else await discardBoundedError(response, expectedGeneration, init.signal, transfer.maxErrorBytes);
    assertRequestCurrent(expectedGeneration, init.signal);
    if (response.status === 401) {
      clearSession();
      throw new ApiError(401, "Your session has expired. Please sign in again.");
    }
    throw new ApiError(response.status, `Download unavailable (HTTP ${response.status}).`,
      response.status === 429 ? retryAfterSeconds(response.headers?.get("Retry-After") ?? null) : undefined);
  }
  try { transfer.validateResponse?.(response); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const blob = await readTransfer(response, init.signal,
    () => assertRequestCurrent(expectedGeneration, init.signal), transfer);
  assertRequestCurrent(expectedGeneration, init.signal);
  return blob;
  } finally { release(); }
}
export const api = {
  serviceInfo: () => request<ServiceInfo>("/service-info"),
  login: async (login: string, password: string) => {
    const value = await request<Session>("/api/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    });
    setSession(value);
    return value;
  },
  session: async () => {
    const value = await request<Session>("/api/session");
    setSession(value);
    return value;
  },
  logout: async () => {
    try {
      await request("/api/logout", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } finally {
      clearSession();
    }
  },
  libraries: () =>
    request<{ items: Library[]; total: number }>("/api/libraries"),
  createLibrary: (value: string) =>
    request("/api/libraries", {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  catalog: (id: string, offset = 0) =>
    request<LibraryPage>(
      `/api/libraries/${encodeURIComponent(id)}?offset=${encodeURIComponent(offset)}`,
    ),
  search: (id: string, query: string, limit: number, g = generation, signal?: AbortSignal) =>
    request<{ id: string }>(`/api/libraries/${encodeURIComponent(id)}/search`, {
      method: "POST",
      body: JSON.stringify({ query, limit }),
      signal,
    }, g),
  run: async (library: string, run: string, offset: number, g = generation, limit = 100, signal?: AbortSignal) => {
    const page = await request<RunPage>(
      `/api/libraries/${encodeURIComponent(library)}/runs/${encodeURIComponent(run)}?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
      { signal },
      g,
    );
    if (page.run.run_id !== run || page.offset !== offset) throw new Error("Saved page did not match the requested run or offset.");
    if (page.continuation != null) validateContinuation(page.continuation, run);
    return page;
  },
  createBatch: (library: string, requestID: string, searchIDs: string[], g = generation, signal?: AbortSignal, format?: "xml" | "pdf") =>
    request<{ id: string }>(
      `/api/libraries/${encodeURIComponent(library)}/batches`,
      { method: "POST", body: JSON.stringify({ requestID, searchIDs, ...(format ? { format } : {}) }), signal },
      g,
    ),
  batch: (library: string, id: string, g = generation, signal?: AbortSignal) =>
    request<BatchDetail>(
      `/api/libraries/${encodeURIComponent(library)}/batches/${encodeURIComponent(id)}`,
      { signal },
      g,
    ),
  controlBatch: (
    library: string,
    id: string,
    value: "pause" | "resume" | "cancel" | "retry",
    g = generation,
    signal?: AbortSignal,
  ) =>
    request(
      `/api/libraries/${encodeURIComponent(library)}/batches/${encodeURIComponent(id)}/control`,
      { method: "POST", body: JSON.stringify({ value }), signal },
      g,
    ),
  original: (library: string, searchID: string, hash: string, g = generation, signal?: AbortSignal, transfer: TransferOptions = {}) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/originals/${encodeURIComponent(searchID)}/${encodeURIComponent(hash)}`,
      { signal },
      g,
      { ...transfer, maxBytes: 32 * 1024 * 1024 },
    ),
  exportCsv: (
    library: string,
    selection: MetadataExportScope,
    g = generation,
    signal?: AbortSignal,
    transfer: TransferOptions = {},
  ) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/exports`,
      { method: "POST", body: JSON.stringify(metadataExportBody(selection, "csv")), signal },
      g,
      { ...transfer, validateResponse: response => validateMetadataResponse(selection, response) },
    ),
  exportXlsx: (
    library: string,
    selection: MetadataExportScope,
    g = generation,
    signal?: AbortSignal,
    transfer: TransferOptions = {},
  ) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/exports`,
      { method: "POST", body: JSON.stringify(metadataExportBody(selection, "xlsx")), signal },
      g,
      { ...transfer, validateResponse: response => validateMetadataResponse(selection, response) },
    ),
  exportBundle: (library: string, batchID: string, g = generation, signal?: AbortSignal, transfer: TransferOptions = {}) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/exports`,
      { method: "POST", body: JSON.stringify({ batchID, format: "zip" }), signal },
      g,
      transfer,
    ),
};
