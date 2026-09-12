export type Session = { csrf: string };
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
  batch: { batch_id: string; state: string; created_at: string };
  items: BatchItem[];
  total: number;
  counts: Record<string, number>;
  policy?: string;
};
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
  generation += 1;
  csrf = "";
  sessionListeners.forEach((listener) => listener());
};
export const setSession = (value: Session) => {
  generation += 1;
  csrf = value.csrf;
};
export async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedGeneration = generation,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.body && csrf) headers.set("X-CSRF", csrf);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (expectedGeneration !== generation)
    throw new Error("Session changed; the previous request was discarded.");
  if (response.status === 401) {
    clearSession();
    throw new Error("Your session has expired. Please sign in again.");
  }
  const text = await response.text();
  if (expectedGeneration !== generation)
    throw new Error("Session changed; the previous response was discarded.");
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
    throw new Error(message);
  }
  return data as T;
}
export async function requestBlob(
  path: string,
  init: RequestInit = {},
  expectedGeneration = generation,
): Promise<Blob> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.body && csrf) headers.set("X-CSRF", csrf);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (expectedGeneration !== generation)
    throw new Error("Session changed; the previous download was discarded.");
  if (response.status === 401) {
    clearSession();
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!response.ok)
    throw new Error(`Download unavailable (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (expectedGeneration !== generation)
    throw new Error("Session changed; the previous download was discarded.");
  return blob;
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
  search: (id: string, query: string, limit: number) =>
    request<{ id: string }>(`/api/libraries/${encodeURIComponent(id)}/search`, {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    }),
  run: (library: string, run: string, offset: number, g = generation) =>
    request<RunPage>(
      `/api/libraries/${encodeURIComponent(library)}/runs/${encodeURIComponent(run)}?offset=${encodeURIComponent(offset)}`,
      {},
      g,
    ),
  createBatch: (library: string, requestID: string, searchIDs: string[]) =>
    request<{ id: string }>(
      `/api/libraries/${encodeURIComponent(library)}/batches`,
      { method: "POST", body: JSON.stringify({ requestID, searchIDs }) },
    ),
  batch: (library: string, id: string, g = generation) =>
    request<BatchDetail>(
      `/api/libraries/${encodeURIComponent(library)}/batches/${encodeURIComponent(id)}`,
      {},
      g,
    ),
  controlBatch: (
    library: string,
    id: string,
    value: "pause" | "resume" | "cancel" | "retry",
  ) =>
    request(
      `/api/libraries/${encodeURIComponent(library)}/batches/${encodeURIComponent(id)}/control`,
      { method: "POST", body: JSON.stringify({ value }) },
    ),
  original: (library: string, searchID: string, hash: string, g = generation) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/originals/${encodeURIComponent(searchID)}/${encodeURIComponent(hash)}`,
      {},
      g,
    ),
  exportCsv: (
    library: string,
    selection: { runID?: string; batchID?: string },
    g = generation,
  ) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/exports`,
      { method: "POST", body: JSON.stringify({ ...selection, format: "csv" }) },
      g,
    ),
  exportBundle: (library: string, batchID: string, g = generation) =>
    requestBlob(
      `/api/libraries/${encodeURIComponent(library)}/exports`,
      { method: "POST", body: JSON.stringify({ batchID, format: "zip" }) },
      g,
    ),
};
