// @vitest-environment jsdom
// Synthetic client lifecycle, distinct from compiled-browser/HTTP acceptance.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlanExports } from "./PlanExports";
import { exportPlan } from "./exports";
import { sessionGeneration, setSession, clearSession } from "../api";

vi.mock("./exports", async original => ({ ...await original<typeof import("./exports")>(), exportPlan: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(exportPlan).mockReset(); clearSession(); });

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
