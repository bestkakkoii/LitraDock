import { researchFlow } from "./research.mjs";
import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const output = path.resolve(process.argv[2] || ".litradock/hosted-browser");
await fs.mkdir(output, { recursive: true });
if (process.env.LITRADOCK_ALLOW_EPHEMERAL_TEST !== "yes")
  throw new Error("Explicit ephemeral test environment required.");
const origin = "http://127.0.0.1:5281";
const login = "browser-" + Date.now();
const password = "Synthetic-browser-password-2026";
const env = {
  ...process.env,
  LITRADOCK_POSTGRES: process.env.LITRADOCK_PG_TEST_CONNECTION,
  LITRADOCK_OBJECTS: path.join(output, "private"),
  LITRADOCK_ORIGIN: origin,
  LITRADOCK_LOCAL_TEST: "true",
  LITRADOCK_PORT: "5281",
  LITRADOCK_INITIAL_LOGIN: login,
  LITRADOCK_INITIAL_PASSWORD: password,
};
const dll = path.join(
  root,
  "build/LitraDock.HostedBrowserHost/Release/net10.0/LitraDock.HostedBrowserHost.dll",
);
const cwd = path.join(root, "src/LitraDock.Hosted");
await promisify(execFile)("dotnet", [dll, "--migrate"], {cwd,env,windowsHide:true});
await promisify(execFile)("dotnet", [dll, "--create-account"], {
  cwd,
  env,
  windowsHide: true,
});
const otherLogin=login+"-other";
await promisify(execFile)("dotnet",[dll,"--create-account"],{cwd,env:{...env,LITRADOCK_INITIAL_LOGIN:otherLogin},windowsHide:true});
let server, browser;
const restoreResponses=[];
const checks = [],
  start = Date.now();
const check = (value, name) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS " + name);
};
function launch() {
  const child = spawn("dotnet", [dll], {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}
async function ready() {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Fixture host did not start.");
}
async function stop(child) {
  if (child && child.exitCode == null) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
}
async function waitStatus(page, text) {
  await page.waitForFunction(
    (value) => document.getElementById("status").textContent.includes(value),
    text,
    { timeout: 60000 },
  );
}
try {
  server = launch();
  await ready();
  browser = await chromium.launch({ headless: true });
  let context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  let page = await context.newPage();
  await page.goto(origin);
  await page.locator('[name="login"]').fill(login);
  await page.locator('[name="password"]').fill(password);
  await page.locator("#login button").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  check(true, "Actual browser account sign-in");
  await page.locator("#newName").fill("Browser synthetic library");
  await page.locator("#newLibrary").click();
  await page.waitForFunction(
    () => document.querySelector("#libraries").value !== "",
  );
  const library = await page.locator("#libraries").inputValue();
  await page.locator("#query").fill("synthetic browser workflow");
  await page.locator("#limit").fill("120");
  await page.locator("#search").click();
  await page.waitForFunction(() =>
    document.querySelector("#runs").textContent.includes("120/125 partial"),
  );
  check(true, "Search shows truthful fetched120/total125 partial coverage");
  await page.locator("#runScope").click();
  await page.locator("#records tr").first().waitFor();
  check(
    (await page.locator("#records tr").count()) === 50,
    "Database-backed first page renders only50 records",
  );
  const leading = await page.locator("thead th").allTextContents();
  check(
    leading.slice(1).join("|") ===
      "Search ID|Title|Authors|Year|DOI|PMID|PMCID|Original URI",
    "Required leading metadata order",
  );
  for (const pmid of [
    77000000, 77000001, 77000002, 77000003, 77000004, 77000005,
  ])
    await page
      .getByRole("checkbox", { name: "Select " + pmid, exact: true })
      .check();
  await page.locator("#next").click();
  await page
    .getByRole("checkbox", { name: "Select 77000050", exact: true })
    .check();
  await page.waitForFunction(() =>
    document.querySelector("#counts").textContent.includes("selected 7"),
  );
  check(true, "Cross-page selection retains exact seven items");
  await page.locator("#template").fill("Study_{SearchId}_{Year}");
  await page.locator("#previewName").click();
  await page.waitForFunction(() =>
    document.querySelector("#namePreview").textContent.includes("Study_LD-"),
  );
  check(
    true,
    "Actual safe naming preview explains artifact extension and hash suffix",
  );
  await page.locator("#acquire").click();
  await page.waitForFunction(
    () => document.querySelector("#batches").value !== "",
  );
  const batch = await page.locator("#batches").inputValue();
  const state = await context.storageState();
  await browser.close();
  browser = null;
  await new Promise((r) => setTimeout(r, 6000));
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    storageState: state,
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  await page.goto(origin);
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#libraries").selectOption(library);
  await page.locator("#batches").selectOption(batch);
  await waitStatus(page, "scheduled 1");
  await page.locator("details").first().evaluate(node=>node.open=true);
  await page.waitForFunction(()=>document.getElementById("nextEvents").textContent.includes("next eligible"));
  check(true,"Browser shows persisted automatic next eligible event after browser closure");
  await waitStatus(page, "completed_with_errors");
  check(
    (await page.locator("#status").textContent()).includes("completed 3"),
    "Acquisition and automatic cooldown continuation complete without Retry after browser closes and reopens",
  );
  for (const outcome of [
    "unavailable",
    "needs_login",
    "failed",
    "challenge",
  ])
    check(
      (await page.locator("#status").textContent()).includes(outcome + " 1"),
      "Visible mixed outcome count " + outcome,
    );
  const row = page
    .locator(".acquisition-item")
    .filter({ hasText: "unavailable" });
  await row
    .getByRole("button", { name: "Continue with original", exact: true })
    .click();
  await page.locator("#manualDialog").waitFor({ state: "visible" });
  const identity = await page.locator("#manualIdentity").textContent();
  const id = identity.split(" · ")[0];
  const csrf = await page.evaluate(
    async () => (await (await fetch("/api/session")).json()).csrf,
  );
  const record = await page.evaluate(
    async ({ library, id }) =>
      (await (await fetch(`/api/libraries/${library}/records/${id}`)).json())
        .article,
    { library, id },
  );
  check(
    [record.title, record.authors, record.doi, record.pmid, record.pmcid].every(
      (value) => value && identity.includes(value),
    ),
    "Visible manual confirmation displays exact title, authors, DOI, PMID and PMCID",
  );
  const xml = `<article><front><article-meta><article-id pub-id-type="pmid">${record.pmid}</article-id><article-id pub-id-type="pmc">${record.pmcid}</article-id><article-id pub-id-type="doi">${record.doi}</article-id><license>Synthetic user original</license></article-meta></front><body><p>Complete synthetic body β 測試</p></body></article>`;
  await page.locator("#manualFile").setInputFiles({
    name: "user-original.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.locator("#manualVersion").selectOption("accepted-manuscript");
  await page.locator("#manualUpload").click();
  await page.waitForFunction(() =>
    document.getElementById("manualStatus").textContent.includes("retained"),
  );
  await page.locator("#manualClose").click();
  await waitStatus(page, "completed 4");
  check(
    true,
    "Browser upload continues same canonical item with validated XML",
  );
  const after = await page.evaluate(
    async ({ library, id }) =>
      await (await fetch(`/api/libraries/${library}/records/${id}`)).json(),
    { library, id },
  );
  check(
    after.article.searchId === id &&
      after.files.length === 1 &&
      after.provenance.length === 1,
    "Manual UI retains record identity and file provenance",
  );
  await page.locator("#scopes").selectOption({ index: 1 });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const downloaded = await downloadPromise;
  await downloaded.saveAs(path.join(output, "browser-report.xlsx"));
  check(
    (await fs.stat(path.join(output, "browser-report.xlsx"))).size > 1000,
    "Actual browser scoped Excel download",
  );
  const denial = await page.evaluate(
    async ({ library, id, hash }) => {
      const r = await fetch(
        `/api/libraries/${library}/records/${id}/files/${hash}`,
      );
      return { status: r.status, body: await r.text() };
    },
    { library, id, hash: after.files[0].hash },
  );
  check(
    denial.status === 200 && denial.body === xml,
    "Authenticated original download preserves exact uploaded bytes",
  );
  const raw = await fetch(
    `${origin}/${library.replaceAll("-", "")}/objects/${after.files[0].hash}.xml`,
  );
  const rawBody = await raw.text();
  check(
    raw.status === 404 && !rawBody.includes("Complete synthetic body"),
    "Anonymous raw object body does not disclose private original",
  );
  const exportNoCsrf = await page.evaluate(
    async ({ library }) =>
      (
        await fetch(`/api/libraries/${library}/scopes/guessed/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    { library },
  );
  check(exportNoCsrf === 403, "Browser export rejects missing CSRF");
  await page.locator("#selectAll").click();
  await page.waitForFunction(() =>
    document.querySelector("#counts").textContent.includes("selected 120"),
  );
  await page.locator("#acquire").click();
  await waitStatus(page, "running");
  const interruptedBatch = await page.locator("#batches").inputValue();
  await page.locator('[data-action="paused"]').click();
  await waitStatus(page, "paused");
  check(true, "Actual browser pause persists before restart");
  await stop(server);
  server = launch();
  await ready();
  await page.reload();
  await page.locator("#libraries").selectOption(library);
  await page.locator("#batches").selectOption(interruptedBatch);
  await waitStatus(page, "paused");
  check(true, "Process restart retains deliberate pause and user session");
  await page.locator('[data-action="resume"]').click();
  await waitStatus(page, "running");
  await page.locator('[data-action="cancelled"]').click();
  await waitStatus(page, "cancelled");
  check(true, "Resume then cancel remains visible and durable");
  check(
    (await page.locator("#batches option:checked").textContent()).endsWith(
      " cancelled",
    ),
    "Selected batch label agrees with fresh durable cancelled progress",
  );
  await page.locator("details").first().evaluate(node=>node.open=true);
  await page.locator("#health").click();
  await page.waitForFunction(()=>document.getElementById("recoveryStatus").textContent.includes('"physicalBytes"'));
  check(true,"Actual browser performs bounded file-health reconciliation");
  const bundleDownload=page.waitForEvent("download");
  await page.locator("#bundle").click();
  const bundle=await bundleDownload;
  const bundlePath=path.join(output,"private-library.zip");
  await bundle.saveAs(bundlePath);
  check((await fs.stat(bundlePath)).size>0,"Actual authorized browser downloads complete private library bundle");
  await page.locator("#bundleFile").setInputFiles(bundlePath);
  const heldDirectory=path.join(output,"admission-holder");await fs.mkdir(heldDirectory,{recursive:true});
  const admission=spawn("dotnet",[path.join(root,"build/LitraDock.HostedVerification/Release/net10.0/LitraDock.HostedVerification.dll"),"--recovery-admission-hold",heldDirectory],{cwd,env,windowsHide:true,stdio:"ignore"});
  let held=false;
  for(let n=0;n<200;n++){try{await fs.stat(path.join(heldDirectory,"held"));held=true;break;}catch{}if(admission.exitCode!==null)break;await new Promise(r=>setTimeout(r,50));}
  check(held,"Separate process actually holds PostgreSQL heavy admission before restore");
  page.on("response",response=>{if(response.url()===origin+"/api/restore"){restoreResponses.push({status:response.status(),admission:response.headers()["x-operation-admission"]||null});console.log("RESTORE_HTTP_STATUS",response.status());}});
  await page.locator("#restoreBundle").click();
  await page.waitForFunction(()=>document.getElementById("recoveryStatus").textContent.includes("admission retry"));
  check(true,"Browser truthfully shows bounded pre-handler admission wait without another click");
  await page.waitForFunction(()=>{const text=document.getElementById("recoveryStatus").textContent;return text.includes("Library restored under your account")||text.includes("Restore response ");},{},{timeout:60000});
  check((await page.locator("#recoveryStatus").textContent()).includes("Library restored under your account"),"Restore response confirms new library after bounded admission wait");
  check(restoreResponses.some(x=>x.status===429 && x.admission==="not-started") && restoreResponses.filter(x=>x.status===200).length===1,"Actual429 admission retry creates exactly one successful restore response");
  const restoredLibrary=await page.locator("#libraries").inputValue();
  check(restoredLibrary!==library,"Browser restore creates a distinct owned library without replacing source");
  const restoredRecords=await context.request.get(origin+"/api/libraries/"+restoredLibrary+"/records/"+id);
  const restoredDetails=await restoredRecords.json();
  check(restoredDetails.article.searchId===id && restoredDetails.files.length>0,"Restored browser record preserves stable canonical identity and file relations");
  const restoredOriginal=await context.request.get(origin+"/api/libraries/"+restoredLibrary+"/records/"+id+"/files/"+restoredDetails.files[0].hash);
  check(restoredOriginal.ok() && (await restoredOriginal.body()).equals(Buffer.from(xml)),"Relocated original download uses restored library association");
  await page.screenshot({path:path.join(output,"browser-recovery.png"),fullPage:true});
  let genericRefusals=0;
  await page.route("**/api/restore",route=>{genericRefusals++;return route.fulfill({status:429,contentType:"application/json",body:JSON.stringify({error:"Synthetic unmarked proxy refusal"})});});
  await page.locator("#restoreBundle").click();
  await page.waitForFunction(()=>document.getElementById("recoveryStatus").textContent.includes("Restore response 429"));
  await page.waitForTimeout(2500);
  const libraryListing=await context.request.get(origin+"/api/libraries");
  check(genericRefusals===1 && (await libraryListing.json()).total===2,"Unmarked proxy429 is not automatically replayed and actual account still has exactly two libraries");
  check((await page.locator("#recoveryStatus").textContent()).includes("Synthetic unmarked proxy refusal"),"Restore failure reason persists across background polling");
  await page.unroute("**/api/restore");
  await stop(server);server=launch();await ready();await page.reload();
  await page.locator("#libraries").selectOption(restoredLibrary);
  const afterRestart=await context.request.get(origin+"/api/libraries/"+restoredLibrary+"/records/"+id+"/files/"+restoredDetails.files[0].hash);
  check(afterRestart.ok() && (await afterRestart.body()).equals(Buffer.from(xml)),"Actual API process restart retains relocated original bytes and user authorization");
  const csrfRejected=await context.request.post(origin+"/api/restore",{headers:{Origin:origin,"Content-Type":"application/octet-stream"},data:await fs.readFile(bundlePath)});
  check(csrfRejected.status()===403,"Actual restore upload fails without session CSRF capability");
  await researchFlow({page,context,origin,library:restoredLibrary,id,record,output,check,otherLogin,password});
  await page.screenshot({
    path: path.join(output, "browser-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    await page.evaluate(
      () =>
        document.querySelector("#progress").clientHeight <=
          innerHeight * 0.55 + 2 &&
        document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Narrow layout bounds batch list height and avoids document-wide horizontal overflow",
  );
  await page.screenshot({
    path: path.join(output, "browser-narrow.png"),
    fullPage: true,
  });
  check(
    await page.locator("#search").isVisible(),
    "Narrow viewport retains workflow controls; screenshot captured",
  );
  await fs.writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        checks: checks.length,
        names: checks,
        elapsedMs: Date.now() - start,
        browser: await browser.version(),
        node: process.version,
        platform: process.platform,
        liveSourceRequests: 0,
        scope:
          "Actual Chromium/HTTP/PostgreSQL with compile-time test-only source fixture; no real institutional session",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const pages = browser?.contexts().flatMap((context) => context.pages()) || [];
  if (pages.length)
    await pages
      .at(-1)
      .screenshot({
        path: path.join(output, "browser-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  await fs.writeFile(
    path.join(output, "failure.json"),
    JSON.stringify({ message: error.message, passed: checks, restoreResponses, visibleError: pages.length ? await pages.at(-1).locator("#error").textContent().catch(()=>"Unavailable") : "Unavailable", recoveryPanel: pages.length ? await pages.at(-1).locator("#recoveryStatus").textContent().catch(()=>"Unavailable") : "Unavailable" }, null, 2),
  );
  throw error;
} finally {
  await fs.writeFile(path.join(output,"restore-responses.json"),JSON.stringify(restoreResponses));
  await browser?.close();
  await stop(server);
}
