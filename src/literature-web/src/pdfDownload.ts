import { api, Article, request, requestBlob, sessionGeneration, SourceOutcome } from "./api";
import { PdfRequest } from "./pdfRequest";
import { PlanPage, PlanSummary, validatePage } from "./plans/api";
import { exportPlan } from "./plans/exports";
import { structuredExport } from "./structuredExport";
import { TransferOptions } from "./transfer";
import { originalKind } from "./originalKind";

export type PdfResult = {
  id: string; article: Article; ready: boolean; pending: boolean; reason: string;
  hash?: string; bytes?: number; format?: string; mediaType?: string; outcome?: SourceOutcome;
};
export type PdfStatus = { items: PdfResult[]; ready: number; pending: number; unresolved: number; plan?: PlanSummary };
type PdfFile = { blob: Blob | null; filename: string; status: PdfStatus };
const invalid = () => new Error("The PDF response did not match this selection. No file was downloaded.");
export function pdfCurrent(intent: PdfRequest, signal: AbortSignal) {
  if (signal.aborted || intent.generation !== sessionGeneration()) throw new Error("PDF download context changed.");
}

// Reading progress never admits work or retries an acquisition. Every returned
// member must belong to the immutable selection captured by this user intent.
export async function readPdfStatus(intent: PdfRequest, signal: AbortSignal): Promise<PdfStatus> {
  pdfCurrent(intent, signal);
  const id = intent.confirmedID;
  if (!id) throw invalid();
  let items: PdfResult[], plan: PlanSummary | undefined;
  if (intent.kind === "batch") {
    const page = await api.batch(intent.library, id, intent.generation, signal);
    if (page.batch?.batch_id !== id || page.requestedFormat !== "pdf" || !Array.isArray(page.items) || page.total !== intent.body.searchIDs.length) throw invalid();
    items = page.items.map(i => ({ id: i.search_id, article: i.article, ready: i.downloadAvailable,
      pending: !["paused", "cancelled"].includes(page.batch.state) && ["queued", "running"].includes(i.state),
      reason: i.reason ?? "", hash: i.original_hash, bytes: i.bytes, format: i.format, mediaType: i.mediaType, outcome: i.sourceOutcome }));
  } else {
    const page = validatePage(await request<PlanPage>(`/api/libraries/${encodeURIComponent(intent.library)}/plans/${encodeURIComponent(id)}?offset=0&limit=100`, { signal }, intent.generation, 8 * 1024 * 1024));
    plan = page.plan;
    if (plan.planID !== id || plan.runID !== intent.runID || plan.scopeKind || plan.requestedFormat !== "pdf" || page.offset !== 0 || page.limit !== 100 || plan.selectedCount !== intent.body.searchIDs.length) throw invalid();
    items = page.items.map(i => ({ id: i.searchID, article: i.article, ready: i.downloadAvailable,
      pending: !["paused", "cancelled"].includes(plan!.state) && ["waiting", "queued", "running"].includes(i.phase),
      reason: i.reason, hash: i.original_hash, bytes: i.bytes, format: i.format, mediaType: i.mediaType, outcome: i.sourceOutcome }));
  }
  pdfCurrent(intent, signal);
  const selected = new Set(intent.body.searchIDs);
  if (items.length !== selected.size || new Set(items.map(i => i.id)).size !== selected.size ||
      items.some(i => !selected.has(i.id) || typeof i.ready !== "boolean" || !i.article || i.article.SearchId !== i.id ||
        (i.ready && (i.pending || originalKind({ downloadAvailable: i.ready, original_hash: i.hash, format: i.format, mediaType: i.mediaType }) !== "pdf" || !/^[a-f0-9]{64}$/.test(i.hash ?? "") || !Number.isSafeInteger(i.bytes) || i.bytes! < 1 || i.bytes! > 8 * 1024 * 1024)))) throw invalid();
  const ready = items.filter(i => i.ready).length, pending = items.filter(i => i.pending).length;
  return { items, ready, pending, unresolved: items.length - ready - pending, plan };
}

export async function pdfFile(intent: PdfRequest, status: PdfStatus, signal: AbortSignal, transfer: TransferOptions = {}, itemID?: string): Promise<PdfFile> {
  pdfCurrent(intent, signal);
  const item = itemID ? status.items.find(i => i.id === itemID) : status.items.length === 1 ? status.items[0] : undefined;
  let blob: Blob, filename: string;
  if (itemID && !item) throw invalid();
  if (item) {
    if (originalKind({ downloadAvailable: item.ready, original_hash: item.hash, format: item.format, mediaType: item.mediaType }) !== "pdf" || !item.hash) throw new Error("This original PDF is not currently available. Open its source links or check again.");
    blob = await requestBlob(`/api/libraries/${encodeURIComponent(intent.library)}/originals/${encodeURIComponent(item.id)}/${encodeURIComponent(item.hash)}`,
      { signal }, intent.generation, { ...transfer, maxBytes: 8 * 1024 * 1024 });
    pdfCurrent(intent, signal);
    const bytes = await blob.arrayBuffer(); pdfCurrent(intent, signal);
    const digest = await crypto.subtle.digest("SHA-256", bytes); pdfCurrent(intent, signal);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    if (blob.type.split(";")[0].trim().toLowerCase() !== "application/pdf" || blob.size !== item.bytes || hash !== item.hash ||
        new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("The original PDF failed its integrity check. No file was downloaded.");
    filename = `litradock-${item.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
  } else {
    if (!status.ready) throw new Error("No original PDF is available for this selection.");
    return pdfPackageFile(intent, status, signal, transfer);
  }
  pdfCurrent(intent, signal);
  return { blob, filename, status };
}

type PackageItem = { searchId: string; available: boolean; file?: string; sha256?: string; bytes?: number; sourceOutcome: SourceOutcome };
// A versioned bounded response binds final scope and current outcomes to the
// exact archive hash. No earlier ready count is evidence of ZIP membership.
async function pdfPackageFile(intent: PdfRequest, previous: PdfStatus, signal: AbortSignal, transfer: TransferOptions): Promise<PdfFile> {
  const path = `/api/libraries/${encodeURIComponent(intent.library)}` + (intent.kind === "plan" ? `/plans/${encodeURIComponent(intent.confirmedID!)}/exports` : "/exports");
  const body = intent.kind === "plan" ? { format: "pdf-download" } : { batchID: intent.confirmedID, format: "pdf-download" };
  const response = await requestBlob(path, { method: "POST", body: JSON.stringify(body), signal }, intent.generation, { ...transfer, maxBytes: 38 * 1024 * 1024 + 4 });
  pdfCurrent(intent, signal);
  if (response.type.split(";")[0].trim().toLowerCase() !== "application/vnd.litradock.pdf-download" || response.size < 4) throw invalid();
  const prefix = await response.slice(0, 4).arrayBuffer(); pdfCurrent(intent, signal);
  const length = new DataView(prefix).getUint32(0);
  if (length < 2 || length > 1024 * 1024 || 4 + length > response.size) throw invalid();
  let report;
  try { report = JSON.parse(await response.slice(4, 4 + length).text()); } catch { throw invalid(); }
  pdfCurrent(intent, signal);
  if (!report || report.schema !== "litradock.pdf-download" || report.schemaVersion !== 1 || report.kind !== intent.kind || report.id !== intent.confirmedID ||
      report.requestedFormat !== "pdf" || (intent.kind === "plan" && report.runID !== intent.runID) || report.selectedCount !== intent.body.searchIDs.length ||
      !Array.isArray(report.items) || report.items.length !== report.selectedCount || !Number.isSafeInteger(report.includedRecords) ||
      report.includedRecords < 0 || report.includedRecords > report.selectedCount || report.unresolvedRecords !== report.selectedCount - report.includedRecords) throw invalid();
  const byID = new Map(previous.items.map(i => [i.id, i])), seen = new Set<string>();
  const items = report.items.map((value: PackageItem): PdfResult => {
    const old = value && byID.get(value.searchId), o = value?.sourceOutcome;
    if (!old || seen.has(value.searchId) || typeof value.available !== "boolean" || !o || o.requestedFormat !== "pdf" ||
        typeof o.status !== "string" || typeof o.label !== "string" || typeof o.detail !== "string" || typeof o.nextAction !== "string" ||
        (o.status === "ready") !== value.available) throw invalid();
    seen.add(value.searchId);
    if (value.available && (!/^[a-f0-9]{64}$/.test(value.sha256 ?? "") || !Number.isSafeInteger(value.bytes) || value.bytes! < 1 || value.bytes! > 8 * 1024 * 1024 ||
        value.file !== (intent.kind === "plan" ? `originals/${value.sha256}.pdf` : `originals/${value.searchId}-${value.sha256}.pdf`) ||
        (old.ready && (old.hash !== value.sha256 || old.bytes !== value.bytes)))) throw invalid();
    if (!value.available && (value.file || value.sha256 || value.bytes)) throw invalid();
    return { ...old, ready: value.available, pending: !value.available && ["queued", "running", "waiting"].includes(o.status),
      reason: o.detail, outcome: o, hash: value.sha256, bytes: value.bytes, format: value.available ? "PDF" : "", mediaType: value.available ? "application/pdf" : "" };
  });
  const ready = items.filter((i: PdfResult) => i.ready).length, pending = items.filter((i: PdfResult) => i.pending).length;
  if (ready !== report.includedRecords || seen.size !== intent.body.searchIDs.length || intent.body.searchIDs.some(id => !seen.has(id))) throw invalid();
  const status: PdfStatus = { items, ready, pending, unresolved: items.length - ready - pending, plan: previous.plan };
  const filename = "litradock-pdfs-and-outcomes.zip";
  const archive = response.slice(4 + length, response.size, "application/zip");
  if (!ready) {
    if (archive.size !== 0 || report.archiveBytes !== 0 || report.archiveSha256 !== "") throw invalid();
    return { blob: null, filename, status };
  }
  if (!/^[a-f0-9]{64}$/.test(report.archiveSha256) || archive.size !== report.archiveBytes || archive.size < 4 || archive.size > 37 * 1024 * 1024) throw invalid();
  const data = await archive.arrayBuffer(); pdfCurrent(intent, signal);
  const hash = await crypto.subtle.digest("SHA-256", data); pdfCurrent(intent, signal);
  if (Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") !== report.archiveSha256 || new Uint8Array(data.slice(0, 4)).join(",") !== "80,75,3,4") throw invalid();
  return { blob: archive, filename, status };
}

export async function pdfOutcomes(intent: PdfRequest, status: PdfStatus, signal: AbortSignal) {
  pdfCurrent(intent, signal);
  return intent.kind === "plan"
    ? exportPlan(intent.library, status.plan!, "json", intent.generation, signal)
    : structuredExport(intent.library, { batchID: intent.confirmedID! }, "json", intent.generation, signal);
}

// A browser does not expose whether the user ultimately saved the file. Only
// claim a handoff, and retain an explicit Save again action for a blocked one.
export function handoffPdf(file: { blob: Blob; filename: string }, intent: PdfRequest, signal: AbortSignal) {
  pdfCurrent(intent, signal);
  const url = URL.createObjectURL(file.blob), anchor = document.createElement("a");
  try {
    anchor.href = url; anchor.download = file.filename; anchor.hidden = true;
    document.body.append(anchor); pdfCurrent(intent, signal); anchor.click();
  } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

export function waitForPdf(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Checking stopped.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
