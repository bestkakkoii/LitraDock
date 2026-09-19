// Compiled browser qualification with labelled synthetic transport. No provider traffic.
import { showWorkspace, openDisclosure } from "./workspace-navigation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preview } from "vite";
import { chromium } from "@playwright/test";

const root = process.cwd();
const out = process.env.NATIVE_SOURCE_OUTCOME_BROWSER_OUTPUT || path.join(root, ".litradock/runtime/native021", new Date().toISOString().replaceAll(/[:.]/g, "-"));
fs.mkdirSync(out, { recursive: true });
const digest = b => crypto.createHash("sha256").update(b).digest("hex");
const dist = Object.fromEntries(fs.readdirSync(path.join(root,"dist"),{recursive:true}).filter(n=>fs.statSync(path.join(root,"dist",n)).isFile()).sort().map(n=>[n,digest(fs.readFileSync(path.join(root,"dist",n)))]));
const states = ["no_deposit","manuscript_tdm","version_ambiguous","restricted","retryable","stored","not_checked","held"];
const labels = ["No deposit in permitted source","Author manuscript / TDM","Deposit version needs review","Source access restricted","Acquisition needs attention","Original stored; validation required","Original not checked","Original held for review"];
const outcome = i => ({ status:states[i], label:labels[i], detail:`SYNTHETIC retained disposition ${i}`, nextAction:"Open the article source links.", requestedFormat:"pdf", evidence:i<2?"retained_source_metadata":"saved_item_outcome", observedAt:i<2?"2026-09-18T14:43:50Z":null, retryEligible:i===4, batchId:i===6?null:"B1", sourceLinks:{pubmed:`https://pubmed.ncbi.nlm.nih.gov/99000000${i}/`,pmc:null,doi:null,doiLinkState:null} });
const article = i => ({SearchId:`S${i}`,Title:`SYNTHETIC source outcome ${i}`,Pmid:`99000000${i}`,OriginalUri:`https://pubmed.ncbi.nlm.nih.gov/99000000${i}/`,SourceOutcome:outcome(i)});
const run = { run_id:"R1",input:"SYNTHETIC captured outcomes",total:25001,fetched:8,state:"partial" };
const planID="PLN-00000000000000000000000000000021";
const plan={planID,runID:"R1",requestedFormat:"pdf",state:"partial",selectedCount:8,createdAt:"2026-09-18",updatedAt:"2026-09-18",revision:1,allowedActions:[],counts:{waiting:0,queued:0,running:0,completed:1,held:6,retry:1,paused:0,cancelled:0},admission:{admittedCount:8,waitingCount:0,blockedReasonCode:"",reason:"",retryAfter:null},retryEligibleCount:1};
const record = i => ({searchId:`S${i}`,runIds:["R1"],identifiers:{pmid:`99000000${i}`,pmcid:null,doi:null},publication:{title:`SYNTHETIC source outcome ${i}`},sourceLinks:outcome(i).sourceLinks,sourceOutcome:outcome(i),acquisition:{state:i===5?"acquired":"unavailable",reason:"SYNTHETIC",requestedFormat:"pdf"},originals:[]});
const exported = Buffer.from(JSON.stringify({schema:"litradock.research-export",schemaVersion:1,type:"document",generatedAt:new Date().toISOString(),scope:{kind:"run",runId:"R1",batchId:null,selection:"all_saved_scope"},counts:{exportedRecords:8,scopeRecords:8,providerMatches:25001,retrievedRecords:8},queryContexts:[],records:states.map((_,i)=>record(i))}));
const server=await preview({root,preview:{host:"127.0.0.1",port:0,strictPort:true}});
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
let browser;const requests=[],errors=[];
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(String(e)));
  let signed=false;
  await page.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method();
    if(url.origin!==origin)return route.abort();
    const reply=(data,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(data)});
    if(url.pathname==="/service-info")return reply({pdfEnabled:true,planEnabled:true,searchEnabled:false,acquisitionEnabled:true});
    if(!url.pathname.startsWith("/api/"))return route.continue();
    requests.push({path:url.pathname,method});
    if(url.pathname==="/api/session")return reply(signed?{csrf:"SYNTHETIC"}:{},signed?200:401);
    if(url.pathname==="/api/login"){signed=true;return reply({csrf:"SYNTHETIC"});}
    if(url.pathname==="/api/logout"){signed=false;return reply({});}
    if(url.pathname==="/api/libraries")return reply({items:[{library_id:"L1",name:"SYNTHETIC A"},{library_id:"L2",name:"SYNTHETIC B"}],total:2});
    if(url.pathname==="/api/libraries/L1")return reply({runs:[run],batches:[{batch_id:"B1",state:"partial"}],totals:{runs:1,batches:1},offset:0,limit:100});
    if(url.pathname==="/api/libraries/L2")return reply({runs:[],batches:[],totals:{runs:0,batches:0},offset:0,limit:100});
    if(url.pathname.endsWith("/runs/R1")){const offset=Number(url.searchParams.get("offset"));return reply({run,records:states.slice(offset,offset+5).map((_,n)=>article(offset+n)),total:8,offset,limit:5});}
    if(url.pathname.endsWith("/batches/B1"))return reply({requestedFormat:"pdf",batch:{batch_id:"B1",state:"partial"},items:states.map((_,i)=>({search_id:`S${i}`,rank:i+1,state:i===5?"acquired":"unavailable",reason:"SYNTHETIC saved reason",attempts:1,article:article(i),downloadAvailable:false,sourceOutcome:outcome(i)})),total:8,counts:{acquired:1,unavailable:7}});
    if(url.pathname.endsWith("/plans"))return reply({plans:url.pathname.includes("L1")?[plan]:[],total:url.pathname.includes("L1")?1:0,offset:0,limit:25});
    if(url.pathname.endsWith(`/plans/${planID}`))return reply({plan,items:states.map((_,i)=>({searchID:`S${i}`,rank:i+1,childBatchID:"B1",phase:i===5?"completed":i===4?"retry":"held",acquisitionState:i===5?"acquired":"unavailable",reason:"SYNTHETIC saved reason",attempts:1,retryEligible:i===4,downloadAvailable:false,article:article(i),sourceOutcome:outcome(i)})),total:8,offset:0,limit:25,nextPollAfterMs:2000});
    if(url.pathname.endsWith("/exports"))return route.fulfill({status:200,contentType:"application/json",body:exported});
    return reply({error:"SYNTHETIC route unavailable"},404);
  });
  await page.goto(origin);await page.getByLabel("Login",{exact:true}).fill("SYNTHETIC");await page.getByLabel("Password",{exact:true}).fill("SYNTHETIC");await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await showWorkspace(page, "Saved searches"); await page.locator(".history-entry").click();await page.getByRole("button",{name:"Select all",exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.selection-toolbar')?.textContent.includes('8 selected of 8'));
  for(const label of labels.slice(0,5))assert((await page.locator(".results .source-outcome, .result-card .source-outcome").allTextContents()).some(s=>s.includes(label)));
  await page.locator('.result-card input').first().uncheck();await page.getByRole("button",{name:"Next records",exact:true}).click();
  await page.locator('.result-card').filter({hasText:labels[7]}).waitFor();
  assert((await page.locator('.selection-toolbar').innerText()).includes('7 selected of 8'));
  for(const label of labels.slice(5))assert((await page.locator('.result-card').allTextContents()).some(s=>s.includes(label)));
  await page.getByRole("button",{name:"Deselect all",exact:true}).click();
  await openDisclosure(page, "Export saved results and other actions");
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole("button",{name:"Export saved run JSON",exact:true}).click();
  const download=await downloadPromise;const filename=path.join(out,'download.json');await download.saveAs(filename);
  const saved=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(saved.counts.scopeRecords,8);assert.deepEqual(saved.records.map(r=>r.sourceOutcome.status),states);assert.equal(digest(fs.readFileSync(filename)),digest(exported));
  await page.getByRole("button",{name:"Previous records",exact:true}).click();
  await page.getByRole("button",{name:"Open saved source outcome",exact:true}).first().click();
  await page.locator('.batch-item .source-outcome').filter({hasText:labels[7]}).waitFor();
  for(const label of labels)assert((await page.locator('.batch-item .source-outcome').allTextContents()).some(s=>s.includes(label)));
  assert.equal(requests.filter(r=>r.method==='POST'&&/\/(searches|batches|plans|control)$/.test(r.path)).length,0);
  await showWorkspace(page, "Research plans"); await page.getByLabel("Saved plans",{exact:true}).selectOption(planID);
  await page.locator('.plan-item').first().waitFor();
  for(const label of labels)assert((await page.locator('.plan-item .source-outcome').allTextContents()).some(s=>s.includes(label)));
  await page.getByLabel("Choose library",{exact:true}).selectOption("L2");
  await page.waitForFunction(()=>!document.querySelector('.result-card')&&!document.querySelector('.batch-item'));
  assert.equal(await page.locator('.source-outcome').count(),0);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({scope:"SYNTHETIC compiled frontend, closed browser transport; no native or live source claim",dist,browser:browser.version(),states,checks:["eight selected across two pages","subset preserved across pages","zero-selected full-scope JSON with exact bytes and all unresolved links/outcomes","open saved batch with zero acquisition POSTs","consistent saved-plan outcomes","library scope clears outcomes"],requests,errors},null,2));
  console.log(JSON.stringify({out,checks:6,providerCalls:0,browser:browser.version()}));
} finally {await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
