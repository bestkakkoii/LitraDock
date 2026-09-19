// @vitest-environment jsdom
// SYNTHETIC interaction tests; layout/compiled-browser acceptance belongs to Agent2.
import { act, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { emptySearchState, SearchController } from "../continuation/controller";
import { ContinuationPanel } from "../continuation/ContinuationPanel";
import { PdfAvailability } from "../components/PdfAvailability";
import { useSavedSelection } from "../savedSelection";
import { downloadExport, ExportContext, exportCounts, ExportResult } from "./api";
import { CaptureControls } from "./CaptureControls";
import { ExportPanel } from "./ExportPanel";
import { capture, context, continuation, runID } from "./fixtures";

vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), downloadExport: vi.fn() }));
let root: Root, host: HTMLDivElement, parent: AbortController;
const button = (label: string) => [...host.querySelectorAll("button")].find(button => button.textContent === label)!;
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("Blob", (await vi.importActual<{ Blob: typeof Blob }>("node:buffer")).Blob);
  setSession({ csrf: "SYNTHETIC" }); parent = new AbortController();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const original = URL;
  vi.stubGlobal("URL", class extends original { static createObjectURL = vi.fn(() => "blob:synthetic"); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(downloadExport).mockReset(); clearSession(); });

it("keeps capture and metadata as separate deliberate controls with original/later counts and missing links", async () => {
  const controller = { action: vi.fn() } as unknown as SearchController;
  const state = emptySearchState();
  await act(async () => root.render(<><CaptureControls status={continuation()} state={state} controller={controller} enabled />
    <ContinuationPanel status={continuation({ missingPMIDs: ["990000007"] })} state={state} controller={controller} visible={25} checked={1001} /></>));
  expect(controller.action).not.toHaveBeenCalled();
  await act(async () => button("Find more results").click());
  expect(controller.action).toHaveBeenCalledExactlyOnceWith(continuation(), "capture");
  await act(async () => button("Load more results").click());
  expect(controller.action).toHaveBeenLastCalledWith(continuation(), "continue");
  expect(host.textContent).toContain("1,000 initial provider matches");
  expect(host.textContent).toContain("700 matches in the latest full-query observation");
  expect(host.textContent).toContain("1002 processed · 1001 saved · 1 missing · 25 visible · 1001 checked");
  expect(host.querySelector('a[href="https://pubmed.ncbi.nlm.nih.gov/990000007/"]')).not.toBeNull();
});
it.each(["disabled", "limited", "complete", "draft"])("%s capture cannot start from the UI", async mode => {
  const controller = { action: vi.fn() } as unknown as SearchController;
  const status = continuation({ capture: capture(mode === "limited" || mode === "complete" ? { state: mode, canCapture: false } : {}) });
  await act(async () => root.render(<CaptureControls status={status} state={emptySearchState()} controller={controller}
    enabled={mode !== "disabled"} blocked={mode === "draft"} />));
  expect(button("Find more results").disabled).toBe(true); button("Find more results").click(); expect(controller.action).not.toHaveBeenCalled();
});
it("does not invent staged controls on schema10", async () => {
  await act(async () => root.render(<CaptureControls status={continuation({ capture: undefined, windowLimit: 1000 })}
    state={emptySearchState()} controller={{} as SearchController} enabled={false} />));
  expect(host.textContent).toBe("");
});

function renderExport(value: ExportContext, compact = false) {
  return act(async () => root.render(<StrictMode><ExportPanel library="L1" context={value} generation={sessionGeneration()}
    signal={parent.signal} compact={compact} onRefresh={vi.fn()} /></StrictMode>));
}
it("StrictMode offers a single complete ZIP for 20000 selected records with 1000-row parts", async () => {
  const value = context({ savedCount: 20000, capturedCount: 20000, processedCount: 20000, missingCount: 0,
    selectedIDs: Array.from({ length: 20000 }, (_, i) => `SYNTHETIC-${i}`) });
  vi.mocked(downloadExport).mockImplementation(async (_library, request) => ({ ...exportCounts(request), blob: new Blob(["SYNTHETIC"], { type: "application/zip" }), filename: "synthetic.zip" }));
  await renderExport(value, true);
  expect(button("Download selected metadata ZIP").closest("details")).toBeNull();
  expect((host.querySelector('[aria-label="Export part size"]') as HTMLSelectElement).value).toBe("1000");
  expect(host.querySelector('[aria-label="Export part size"] option[value="1"]')).not.toBeNull();
  await act(async () => { button("Download selected metadata ZIP").click(); button("Download selected metadata ZIP").click(); });
  expect(downloadExport).toHaveBeenCalledTimes(1);
  expect(vi.mocked(downloadExport).mock.calls[0][1]).toMatchObject({ format: "zip-csv", scope: "selected", offset: 0, limit: 1000 });
  expect(host.textContent).toContain("20,000 saved metadata records sent to your browser in one ZIP");
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
});
it("a new revision cancels an old download, resets parts and cannot inherit a late completion", async () => {
  const held: Array<(value: ExportResult) => void> = [];
  vi.mocked(downloadExport).mockImplementation(() => new Promise(resolve => held.push(resolve)));
  await renderExport(context()); await act(async () => button("Download first part").click());
  await renderExport(context({ captureRevision: 8 }));
  expect(host.textContent).toContain("New downloads start a new export scope");
  await act(async () => button("Download first part").click());
  const result = { count: 1000, scopeCount: 1001, remaining: 1, offset: 0, complete: false, blob: new Blob(["SYNTHETIC"]), filename: "synthetic.csv" };
  await act(async () => held[0](result)); expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(button("Download first part").disabled).toBe(true);
  await act(async () => held[1](result)); expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Next part: records 1001–1001 of 1001. 1 remaining");
});

it("schema11 restores 20000 selection IDs while leaving PDF details bounded to 100", async () => {
  let selection!: ReturnType<typeof useSavedSelection>;
  const ids = Array.from({ length: 20000 }, (_, i) => `SYNTHETIC-${i}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runID, revision: 7, savedCount: ids.length, selectedCount: ids.length,
    selectedIDs: ids, selectedRecords: [], defaultSelected: false, recordsComplete: false, recordsReason: "SYNTHETIC 100-record detail boundary",
    canEdit: true, selectionLimit: 20000, detailLimit: 100 }))));
  function Harness() {
    selection = useSavedSelection("L1", { run_id: runID, input: "SYNTHETIC", total: 20000, fetched: 20000, state: "partial" }, sessionGeneration(), parent.signal, [],
      { stagedQueryEnabled: false, durableSelectionEnabled: true, selectionWriteEnabled: true, selectionRecordLimit: 20000 });
    return <PdfAvailability selectedCount={selection.count} ids={[...selection.ids]} ready={selection.detailsReady} enabled plansEnabled
      library="L1" runID={runID} generation={sessionGeneration()} scopeSignal={parent.signal} />;
  }
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  for (let i = 0; i < 30 && !selection.ready; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(selection.ready).toBe(true); expect(selection.count).toBe(20000); expect(selection.ids).toEqual(ids); expect(selection.detailsReady).toBe(false);
  const pdf = [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Download PDFs"))!;
  expect(pdf.disabled).toBe(true); expect(host.textContent).toContain("100");
});
