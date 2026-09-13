// @vitest-environment jsdom
// Synthetic component fixtures only; no native handler or provider evidence.
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SearchHistory } from "./SearchHistory";
import { PdfAvailability } from "./PdfAvailability";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const run = { run_id: "SYNTHETIC-RUN-001", input: '("SYNTHETIC α 中文"[MeSH Terms] OR "long title"[Title]) AND 2020:2024[dp]\n<script>not markup</script>', total: 25001, fetched: 3, state: "partial", reason: "SYNTHETIC retrieval cap" };
async function mount(busy = false, offset = 0, total = 1) {
  const onOpen = vi.fn(), onPage = vi.fn();
  await act(async () => root.render(<SearchHistory runs={[run]} total={total} offset={offset} selectedID={run.run_id} busy={busy} onOpen={onOpen} onPage={onPage} />));
  return { onOpen, onPage };
}
it("shows full exact query, distinct counts and durable identity as text, without invented date or filters", async () => {
  const { onOpen } = await mount();
  expect(host.querySelector('.history-query')?.textContent).toBe(run.input);
  expect(host.textContent).toContain("25001 provider matches");
  expect(host.textContent).toContain("3 retrieved records");
  expect(host.textContent).toContain(run.run_id);
  expect(host.textContent).toContain("Search time and separate filter details are not supplied");
  expect(host.querySelector("script, time, select")).toBeNull();
  const entry = host.querySelector<HTMLButtonElement>('.history-entry')!;
  expect(entry.getAttribute("aria-pressed")).toBe("true");
  await act(async () => entry.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(run.run_id);
});
it("keeps history paging and in-flight controls honest", async () => {
  const { onPage } = await mount(false, 100, 101);
  const buttons = [...host.querySelectorAll("nav button")] as HTMLButtonElement[];
  expect(buttons[1].disabled).toBe(true);
  await act(async () => buttons[0].click());
  expect(onPage).toHaveBeenCalledExactlyOnceWith(0);
  const pending = await mount(true);
  await act(async () => host.querySelector<HTMLButtonElement>('.history-entry')!.click());
  expect(pending.onOpen).not.toHaveBeenCalled();
});
it("makes PDF unavailability visible even when records are selected, without an acquisition action", async () => {
  await act(async () => root.render(<PdfAvailability selectedCount={37} />));
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Download PDFs (37 selected)");
  expect(host.textContent).toContain("PDF acquisition is currently unavailable");
  expect(host.textContent).toContain("XML and ZIP are not PDFs");
  expect(host.querySelector("a")).toBeNull();
});
