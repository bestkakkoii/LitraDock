// @vitest-environment jsdom
// Synthetic client lifecycle, distinct from compiled-browser/HTTP acceptance.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlanExports } from "./PlanExports";
import { exportPlan } from "./exports";
import { snapshotMetadata } from "./snapshotMetadata";
import { sessionGeneration, setSession, clearSession } from "../api";

vi.mock("./exports", async original => ({ ...await original<typeof import("./exports")>(), exportPlan: vi.fn() }));
vi.mock("./snapshotMetadata", async original => ({ ...await original<typeof import("./snapshotMetadata")>(), snapshotMetadata: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(exportPlan).mockReset(); vi.mocked(snapshotMetadata).mockReset(); clearSession(); });

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
  const save = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Export snapshot JSON")!;
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
