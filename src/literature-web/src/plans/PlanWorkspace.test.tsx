// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, sessionGeneration, setSession } from "../api";
import { PlanWorkspace } from "./PlanWorkspace";
import { detail, summary } from "./fixtures.test-support";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  setSession({ csrf: "synthetic" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); clearSession(); });
function button(name: string) {
  const result = [...host.querySelectorAll("button")].find(item => item.textContent === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function mount(enabled = true, signal = new AbortController().signal) {
  const child = vi.fn(), change = vi.fn();
  await act(async () => root.render(<PlanWorkspace library="synthetic-library" runID="synthetic-run"
    generation={sessionGeneration()} selectedIDs={Array.from({length:37}, (_,i) => `synthetic-${i}`)} enabled={enabled}
    scopeSignal={signal} onPlanChange={change} onChild={child} />));
  return { child, change };
}
async function openPlan() {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Saved plans"]')!;
    select.value = "synthetic-plan"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("renders scoped counts, held safe links and child navigation; cancel needs explicit confirmation", async () => {
  const calls: {url: string; body?: Record<string, unknown>}[] = [];
  const paused = { state: "paused", counts: { ...summary().counts, waiting: 0, paused: 27 } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({url, body: init.body ? JSON.parse(String(init.body)) : undefined});
    return new Response(JSON.stringify(init.method === "POST" ? {planID:"synthetic-plan",revision:4,state:"cancelled"}
      : url.includes("/synthetic-plan?") ? detail(paused) : {plans:[summary(paused)],total:1,offset:0,limit:25}), {status:200});
  }));
  const { child, change } = await mount();
  expect(button("Create processing plan (37/100)").disabled).toBe(false);
  await openPlan();
  expect(change).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("37 selected saved records");
  expect(host.textContent).toContain("10 admitted to child batches · 27 awaiting admission");
  expect(host.textContent).toContain("0 of 1 items on this page currently available to save");
  expect(host.querySelectorAll(".plan-counts > div")).toHaveLength(8);
  expect(host.querySelector("script")).toBeNull();
  expect(host.textContent).toContain("Synthetic <script> hostile α 中文");
  expect(host.querySelector('a')?.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/990000001/");
  await click("Open child batch synthetic-batch");
  expect(child).toHaveBeenCalledWith("synthetic-batch");
  expect(button("Resume plan").disabled).toBe(true); // server actions win over local state inference
  await click("Cancel plan");
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(calls.filter(x => x.body)).toHaveLength(0);
  await click("Keep plan");
  await click("Cancel plan");
  await click("Confirm cancellation");
  expect(calls.filter(x => x.body)).toHaveLength(1);
  expect(calls.find(x => x.body)?.body).toMatchObject({ value:"cancel", expectedRevision:3 });
});

it("disabled capability preserves GET catalog and permitted controls; scope abort clears private detail", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/synthetic-plan?") ? detail() : {plans:[summary()],total:1,offset:0,limit:25}))));
  const abort = new AbortController();
  await mount(false, abort.signal);
  expect(host.textContent).not.toContain("Create processing plan (");
  await openPlan();
  expect(button("Pause plan").disabled).toBe(false);
  expect(button("Resume plan").disabled).toBe(true);
  await act(async () => abort.abort());
  expect(host.textContent).not.toContain("Synthetic <script>");
  expect(host.textContent).not.toContain("Plan synthetic-plan");
});
