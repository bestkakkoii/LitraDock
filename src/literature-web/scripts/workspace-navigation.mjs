import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// A durable checkbox changes only after its server receipt and reread.
export async function setSavedCheck(locator, checked) {
  await expect(locator).toBeEnabled();
  if (await locator.isChecked() !== checked) await locator.click();
  await expect(locator).toBeChecked({ checked });
  await expect(locator).toBeEnabled();
}

// Exercise the same visible workspace controls as a researcher. Hidden sections
// remain mounted; a DOM match alone does not make their controls actionable.
export async function showWorkspace(page, name) {
  const button = page.getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name, exact: true });
  await button.click();
  assert.equal(await button.getAttribute("aria-current"), "page", `Workspace did not open: ${name}`);
}

export async function openDisclosure(scope, name) {
  const text = typeof name === "string" ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : name;
  const summary = scope.locator("summary").filter({ hasText: text });
  await summary.waitFor({ state: "visible" });
  const details = summary.locator("..");
  if (!await details.evaluate(element => element.open)) await summary.click();
  assert(await details.evaluate(element => element.open), `Disclosure did not open: ${name}`);
}

// SYNTHETIC in-process selection service for existing isolated browser drivers.
// No provider or app backend calls. The dedicated durable-selection driver uses
// its own independent HTTP model and fault schedules.
export function createSelectionFixture() {
  const runs = new Map();
  return (key, runID, records, method, body, reply) => {
    const ids = records.map(record => record.SearchId), membership = JSON.stringify(ids);
    let saved = runs.get(key);
    if (!saved) { saved = { revision: 1, defaultSelected: true, exceptions: new Map(), receipts: new Map(), membership }; runs.set(key, saved); }
    if (saved.membership !== membership) { saved.membership = membership; saved.revision++; }
    if (method === "POST") {
      const prior = saved.receipts.get(body.requestID);
      if (prior) return reply(JSON.stringify(body) === prior.intent ? prior.receipt : { error: "SYNTHETIC changed replay" }, JSON.stringify(body) === prior.intent ? 200 : 409);
      if (body.revision !== saved.revision) return reply({ error: "SYNTHETIC revision conflict" }, 409);
      assert.match(body.requestID, /^[a-f0-9-]{36}$/i);
      if (body.action === "set") {
        assert(body.ids.length >= 1 && body.ids.length <= 100); assert.equal(new Set(body.ids).size, body.ids.length);
        assert.equal(typeof body.selected, "boolean"); assert(body.ids.every(id => ids.includes(id)));
        body.ids.forEach(id => saved.exceptions.set(id, body.selected));
      } else { assert(["all", "none"].includes(body.action)); assert.equal(body.ids, undefined); assert.equal(body.selected, undefined); saved.defaultSelected = body.action === "all"; saved.exceptions.clear(); }
      const receipt = { runID, requestID: body.requestID, revision: ++saved.revision };
      saved.receipts.set(body.requestID, { intent: JSON.stringify(body), receipt }); return reply(receipt);
    }
    const selected = records.filter(record => saved.exceptions.get(record.SearchId) ?? saved.defaultSelected);
    return reply({ runID, revision: saved.revision, defaultSelected: saved.defaultSelected, savedCount: records.length,
      selectedCount: selected.length, selectedIDs: selected.map(record => record.SearchId), selectedRecords: selected.length <= 100 ? selected : [],
      recordsComplete: selected.length <= 100, recordsReason: selected.length <= 100 ? "" : "SYNTHETIC detail limit: 100 records.", canEdit: true, selectionLimit: 1000, detailLimit: 100 });
  };
}
