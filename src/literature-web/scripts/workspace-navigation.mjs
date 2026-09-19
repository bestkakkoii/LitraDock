import assert from "node:assert/strict";

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
