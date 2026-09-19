// Actual compiled-client helpers: wait for the durable write and read-back,
// never replace native handlers or optimistically treat a click as persistence.
import assert from 'node:assert/strict';

export async function readNativeJson(page, url) {
  // Independent test probes share the real two-request admission capacity with
  // the UI. Respect its explicit not-started response without retrying writes.
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await page.request.get(url);
    if (response.status() !== 429) {
      assert.equal(response.status(), 200);
      return response.json();
    }
    assert.equal(response.headers()['retry-after'], '2');
    assert.equal((await response.json()).code, 'admission_not_started');
    await page.waitForTimeout(2000);
  }
  throw Error('Read-only native probe admission remained unavailable');
}

export async function selectionReady(page) {
  const ready = page.getByRole('region', {name: 'Saved record selection', exact: true})
    .getByRole('button', {name: 'Select all saved', exact: true});
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await ready.isEnabled()) return;
    await page.waitForTimeout(50);
  }
  throw Error('Durable saved selection did not finish read-back');
}

export async function selectionControl(page, name) {
  await selectionReady(page);
  const area = page.getByRole('region', {name: 'Saved record selection', exact: true});
  if (['Select page', 'Deselect page'].includes(name) && !await area.getByRole('button', {name, exact: true}).isVisible()) {
    await area.locator('.selection-scope > summary').click();
  }
  const receipt = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/selection'));
  await area.getByRole('button', {name, exact: true}).click();
  assert.equal((await receipt).status(), 200);
  await selectionReady(page);
}

export async function setSavedCheckbox(page, box, checked) {
  await selectionReady(page);
  if (await box.isChecked() === checked) return;
  const receipt = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/selection'));
  await box.click();
  assert.equal((await receipt).status(), 200);
  await selectionReady(page);
  assert.equal(await box.isChecked(), checked);
}
