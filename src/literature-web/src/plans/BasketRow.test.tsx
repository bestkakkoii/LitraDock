// @vitest-environment jsdom
// Explicitly SYNTHETIC records; no native handlers or provider requests.
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSession, clearSession, sessionGeneration } from "../api";
import { BasketRow } from "./BasketRow";
import { PlanWorkspace } from "./PlanWorkspace";

let host: HTMLDivElement, root: Root;
const ids = ["1", "2"].map(n => `LD-${n.repeat(32)}`);
const runs = ["a", "b"].map(n => `RUN-${n.repeat(32)}`);
const title = 'SYNTHETIC 中文 Ελληνικά "MeSH" <img src=x> AND multilingual long title';
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  setSession({ csrf: "SYNTHETIC" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearSession(); vi.unstubAllGlobals(); });

it("keeps complete identity/provenance behind native details and removes the exact similar-title record", async () => {
  const remove = vi.fn();
  await act(async () => root.render(<>{ids.map((searchID, index) => <BasketRow key={searchID} position={index + 1}
    member={{ searchID, runIDs: runs, article: { Title: title, Journal: "SYNTHETIC Journal", Year: 2024, Authors: "陳小明; Δέλτα" } }} onRemove={remove} />)}</>));
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.map(b => b.textContent)).toEqual(["Remove", "Remove"]);
  expect(buttons[0].getAttribute("aria-label")).not.toBe(buttons[1].getAttribute("aria-label"));
  expect(host.querySelectorAll("details:not([open])")).toHaveLength(2);
  expect(host.querySelector(".basket-row-heading")!.textContent).not.toContain("LD-");
  expect(host.querySelector("details")!.textContent).toContain(ids[0]);
  expect([...host.querySelectorAll("details")][1].textContent).toContain(runs[1]);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector(".basket-bibliography")!.textContent).toBe("SYNTHETIC Journal · 2024 · 陳小明; Δέλτα");
  await act(async () => buttons[1].click()); expect(remove).toHaveBeenCalledExactlyOnceWith(ids[1]);
});

it("does not invent missing bibliography or use an opaque identifier as the title", async () => {
  const authors = "SYNTHETIC full ordered authors α 中文 ".repeat(5);
  await act(async () => root.render(<><BasketRow position={1} member={{ searchID: ids[0], runIDs: runs, article: {} }} onRemove={() => {}} />
    <BasketRow position={2} member={{ searchID: ids[1], runIDs: runs, article: { Title: title, Authors: authors } }} onRemove={() => {}} /></>));
  expect(host.querySelector("h4")!.textContent).toBe("Title not supplied");
  expect(host.querySelector(".basket-bibliography")!.textContent).toBe("Bibliographic details not supplied.");
  expect(host.querySelectorAll(".basket-bibliography")[1].textContent).toBe("Author list in details");
  expect(host.querySelectorAll("details")[1].textContent).toContain(authors);
});

it("actual workspace removal preserves the other record and its merged run associations without POST", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ plans: [], offset: 0, limit: 25, total: 0 })));
  vi.stubGlobal("fetch", fetcher); const scope = new AbortController();
  const render = async (runID: string) => act(async () => root.render(<PlanWorkspace library="SYNTHETIC-L" runID={runID}
    generation={sessionGeneration()} selectedIDs={ids} selectedArticles={ids.map(SearchId => ({ SearchId, Title: title }))}
    enabled={false} scopeSignal={scope.signal} onPlanChange={() => {}} onChild={() => {}} />));
  const add = async () => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("Add checked"))!.click());
  await render(runs[0]); await add(); await render(runs[1]); await add(); await add();
  expect(host.querySelectorAll(".basket-row")).toHaveLength(2);
  expect(host.textContent).toContain("currently 4 associations");
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".basket-remove")[1].click());
  expect(host.querySelectorAll(".basket-row")).toHaveLength(1);
  const remaining = host.querySelector(".basket-provenance")!;
  expect(remaining.textContent).toContain(ids[0]); expect(remaining.textContent).not.toContain(ids[1]);
  expect([...remaining.querySelectorAll("li")].map(li => li.textContent)).toEqual(runs);
  expect(host.textContent).toContain("currently 2 associations");
  expect(fetcher.mock.calls.every(call => !((call as unknown[])[1] as RequestInit)?.body)).toBe(true);
  await act(async () => scope.abort()); expect(host.querySelectorAll(".basket-row")).toHaveLength(0);
});
