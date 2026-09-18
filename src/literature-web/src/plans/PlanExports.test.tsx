// @vitest-environment jsdom
// Synthetic client lifecycle, distinct from compiled-browser/HTTP acceptance.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlanExports } from "./PlanExports";
import { exportPlan } from "./exports";
import { snapshotMetadata } from "./snapshotMetadata";
import { sessionGeneration, setSession, clearSession } from "../api";
import { exportFixture } from "./export-fixture.test-support";

vi.mock("./exports", async original => ({ ...await original<typeof import("./exports")>(), exportPlan: vi.fn() }));
vi.mock("./snapshotMetadata", async original => ({ ...await original<typeof import("./snapshotMetadata")>(), snapshotMetadata: vi.fn() }));
// Partition preparation has its own driver; isolate these export affordances.
vi.mock("../bundles/BundleWorkspace", () => ({ BundleWorkspace: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(exportPlan).mockReset(); vi.mocked(snapshotMetadata).mockReset(); clearSession(); });

it.each(["pdf", "xml", undefined] as const)("labels requested format %s accurately without changing ZIP intent", async requestedFormat => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setSession({ csrf: "SYNTHETIC" });
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => "blob:synthetic"); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.mocked(exportPlan).mockResolvedValue({ blob: new Blob(["SYNTHETIC validated archive"]), filename: "litradock-plan-originals.zip" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const scope = new AbortController(), planScope = new AbortController();
  const plan = { planID: "SYNTHETIC-P", runID: "R", selectedCount: 3, requestedFormat };
  try {
    await act(async () => root.render(<PlanExports library="L" runID="R" generation={sessionGeneration()}
      plan={plan} scopeSignal={scope.signal} planSignal={planScope.signal} />));
    const label = requestedFormat === "pdf" ? "Download available PDFs ZIP" : "Download available originals ZIP";
    const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);
    expect(button).toBeDefined(); expect(button!.disabled).toBe(false);
    if (requestedFormat !== "pdf") expect(host.textContent).not.toContain("Download available PDFs ZIP");
    expect(host.textContent).not.toContain("Export research snapshot JSON");
    await act(async () => button!.click());
    expect(exportPlan).toHaveBeenCalledWith("L", plan, "zip", sessionGeneration(), expect.any(AbortSignal), expect.any(Object));
    expect(click).toHaveBeenCalledOnce(); expect(snapshotMetadata).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

// The component chooses a route helper, not membership: held records and records
// outside the visible page remain in the immutable full-scope identity.
it("distinguishes whole-plan JSON from typed research snapshot formats and cancels without saving", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setSession({ csrf: "SYNTHETIC" });
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => "blob:synthetic"); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const plan = { planID: `PLN-${"1".repeat(32)}`, runID: "", scopeKind: "saved_snapshot" as const,
    sourceRunIDs: ["SYNTHETIC-R1", "SYNTHETIC-R2"], selectedCount: 37 };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const scope = new AbortController(), planScope = new AbortController();
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === label)!;
  const pending: Array<(value: { blob: Blob; filename: string }) => void> = [];
  vi.mocked(exportPlan).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  vi.mocked(snapshotMetadata).mockResolvedValue({ blob: new Blob(["SYNTHETIC"]), filename: "litradock-saved-research.json" });
  try {
    await act(async () => root.render(<PlanExports library="SYNTHETIC-L" runID="" generation={sessionGeneration()}
      plan={plan} scopeSignal={scope.signal} planSignal={planScope.signal} />));
    expect(host.querySelector("#plan-export-scope")?.textContent).toContain("All 37 saved members, including held records");
    expect(exportPlan).not.toHaveBeenCalled(); expect(snapshotMetadata).not.toHaveBeenCalled();
    await act(async () => button("Export plan metadata JSON").click());
    expect(exportPlan).toHaveBeenCalledWith("SYNTHETIC-L", plan, "json", sessionGeneration(), expect.any(AbortSignal), expect.any(Object));
    expect(snapshotMetadata).not.toHaveBeenCalled();
    expect(button("Export research snapshot JSON").disabled).toBe(true);
    const signal = vi.mocked(exportPlan).mock.calls[0][4];
    await act(async () => button("Cancel transfer").click());
    expect(signal.aborted).toBe(true);
    await act(async () => pending[0]({ blob: new Blob(["CANCELLED SYNTHETIC"]), filename: "cancelled.json" }));
    expect(click).not.toHaveBeenCalled();
    for (const format of ["json", "jsonl", "csv", "xlsx"] as const) {
      await act(async () => button(`Export research snapshot ${format.toUpperCase()}`).click());
      expect(snapshotMetadata).toHaveBeenLastCalledWith("SYNTHETIC-L", plan, format, sessionGeneration(), expect.any(AbortSignal), expect.any(Object));
    }
    expect(click).toHaveBeenCalledTimes(4);
    expect(exportPlan).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("ZIP manifest JSON");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("routes the two JSON actions to their existing endpoints with only format and saves validated UTF-8 bytes", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom 26 lacks Blob.arrayBuffer/text; use the real Node Blob implementation
  // for the unmocked response validators, not a bypass of their byte checks.
  vi.stubGlobal("Blob", (await vi.importActual<{ Blob: typeof Blob }>("node:buffer")).Blob);
  setSession({ csrf: "SYNTHETIC-CSRF" });
  vi.mocked(exportPlan).mockImplementation((await vi.importActual<typeof import("./exports")>("./exports")).exportPlan);
  vi.mocked(snapshotMetadata).mockImplementation((await vi.importActual<typeof import("./snapshotMetadata")>("./snapshotMetadata")).snapshotMetadata);
  const planID = `PLN-${"2".repeat(32)}`;
  const identity = { planID, runID: "", selectedCount: 3, scopeKind: "saved_snapshot" as const, sourceRunIDs: ["R1"] };
  const metadata = exportFixture(planID);
  Object.assign(metadata.plan, identity, { state: "saved_snapshot", retryEligibleCount: 0,
    admission: { admittedCount: 0, waitingCount: 0 } });
  Object.assign(metadata.research.scope, { kind: "saved_snapshot" });
  metadata.research.records.forEach(record => Object.assign(record, { runIds: ["R1"] }));
  const bodies = [JSON.stringify(metadata), JSON.stringify(metadata.research)];
  const fetch = vi.fn(async (url: string) => new Response(url === "/service-info" ? JSON.stringify({}) : bodies[url.endsWith("/metadata") ? 1 : 0],
    { headers: { "Content-Type": "application/json;charset=utf-8" } }));
  vi.stubGlobal("fetch", fetch);
  const saved: Blob[] = [], names: string[] = [];
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn((blob: Blob) => { saved.push(blob); return "blob:synthetic"; }); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const scope = new AbortController(), planScope = new AbortController();
  try {
    await act(async () => root.render(<PlanExports library="SYNTHETIC-L" runID="" generation={sessionGeneration()}
      plan={identity} scopeSignal={scope.signal} planSignal={planScope.signal} />));
    for (const label of ["Export plan metadata JSON", "Export research snapshot JSON"]) {
      await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === label)!.click());
    }
    const exportCalls = fetch.mock.calls.filter(call => call[0] !== "/service-info");
    expect(exportCalls.map(call => call[0])).toEqual([
      `/api/libraries/SYNTHETIC-L/plans/${planID}/exports`, `/api/libraries/SYNTHETIC-L/plans/${planID}/metadata`,
    ]);
    for (const call of exportCalls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).toBe("POST"); expect(JSON.parse(String(init.body))).toEqual({ format: "json" });
      expect(new Headers(init.headers).get("X-CSRF")).toBe("SYNTHETIC-CSRF");
    }
    expect(host.querySelector(".plan-exports [role=alert]")?.textContent).toBeUndefined();
    expect(names).toEqual(["litradock-plan.json", "litradock-saved-research.json"]);
    expect(await Promise.all(saved.map(blob => blob.text()))).toEqual(bodies);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("coalesces same-turn double clicks and old finally cannot release a newer scoped export", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setSession({ csrf: "SYNTHETIC" });
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => "blob:synthetic"); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const pending: Array<(value: { blob: Blob; filename: string }) => void> = [];
  vi.mocked(exportPlan).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const scope = new AbortController(), planScope = new AbortController();
  const render = (planID: string) => root.render(<PlanExports library="L" runID="R" generation={sessionGeneration()}
    plan={{ planID, runID: "R", selectedCount: 3 }} scopeSignal={scope.signal} planSignal={planScope.signal} />);
  const save = () => host.querySelectorAll("button")[1];
  try {
    await act(async () => render("P1"));
    await act(async () => { save().click(); save().click(); }); expect(exportPlan).toHaveBeenCalledTimes(1);
    await act(async () => render("P2")); expect(save().disabled).toBe(false);
    await act(async () => save().click()); expect(exportPlan).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]({ blob: new Blob(["OLD SYNTHETIC"]), filename: "old.json" }));
    expect(click).not.toHaveBeenCalled(); expect(save().disabled).toBe(true);
    await act(async () => pending[1]({ blob: new Blob(["NEW SYNTHETIC"]), filename: "litradock-plan.json" }));
    expect(click).toHaveBeenCalledOnce(); expect(save().disabled).toBe(false);
    expect(host.textContent).not.toContain("OLD");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("typed snapshot old rejection cannot clear newer library busy/error or hand off a file", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setSession({ csrf: "SYNTHETIC" });
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => "blob:synthetic"); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const pending: Array<{ resolve: (value: { blob: Blob; filename: string }) => void; reject: (error: Error) => void }> = [];
  vi.mocked(snapshotMetadata).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const scope = new AbortController(), planScope = new AbortController();
  const render = (library: string) => root.render(<PlanExports library={library} runID="" generation={sessionGeneration()}
    plan={{ planID: `PLN-${"1".repeat(32)}`, runID: "", scopeKind: "saved_snapshot", sourceRunIDs: ["R1"], selectedCount: 1 }}
    scopeSignal={scope.signal} planSignal={planScope.signal} />);
  const save = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Export research snapshot JSON")!;
  try {
    await act(async () => render("L1"));
    await act(async () => { save().click(); save().click(); });
    expect(snapshotMetadata).toHaveBeenCalledTimes(1);
    await act(async () => render("L2"));
    await act(async () => save().click());
    await act(async () => pending[0].reject(new Error("OLD SYNTHETIC 503")));
    expect(save().disabled).toBe(true); expect(host.textContent).not.toContain("OLD"); expect(click).not.toHaveBeenCalled();
    await act(async () => pending[1].resolve({ blob: new Blob(["NEW SYNTHETIC"]), filename: "litradock-saved-research.json" }));
    expect(save().disabled).toBe(false); expect(click).toHaveBeenCalledOnce();
    expect(vi.mocked(snapshotMetadata).mock.calls.map(args => args[0])).toEqual(["L1", "L2"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
