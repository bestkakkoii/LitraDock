// SYNTHETIC transport only; backend admission/rights are independently qualified.
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, clearSession, sessionGeneration, setSession } from "../api";
import { PlanController } from "./controller";
import { validateCreateReceipt, validatePage } from "./api";
import { detail, summary } from "./fixtures.test-support";
import { metadataFailure, snapshotMetadata } from "./snapshotMetadata";
import { exportFixture } from "./export-fixture.test-support";
import { fixtureDocument } from "../bundles/fixtures";
import { validateDocument } from "../bundles/model";
import { validatePlanMetadata } from "./exports";
const id = `PLN-${"1".repeat(32)}`;
const plan = () => summary({ planID: id, scopeKind: "saved_snapshot", runID: "", sourceRunIDs: ["R1", "R2"], state: "saved_snapshot", revision: 1,
  selectedCount: 1, allowedActions: [], counts: { waiting: 0, queued: 0, running: 0, completed: 1, held: 0, retry: 0, paused: 0, cancelled: 0 },
  admission: { admittedCount: 0, waitingCount: 0, reason: "No acquisition requested", blockedReasonCode: "", retryAfter: null }, retryEligibleCount: 0 });
const page = () => ({ ...detail(), plan: plan(), total: 1, items: detail().items.map(item => ({ ...item, childBatchID: null, retryEligible: false })) });
const receipt = { planID: id, state: "saved_snapshot", revision: 1, selectedCount: 1, affectedCount: 0 };
const members = [{ searchID: "S1", runIDs: ["R2", "R1"] }];
const models: PlanController[] = [];
const model = () => { const c = new PlanController("L", "R1", sessionGeneration(), () => {}); models.push(c); return c; };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
it("partition snapshot validates full saved-snapshot provenance without weakening existing guard",()=>{
  const d:any=fixtureDocument();Object.assign(d.manifest.plan,{runID:"",scopeKind:"saved_snapshot",sourceRunIDs:["R1","R2"]});
  d.manifest.research.scope.kind="saved_snapshot";
  expect(()=>validateDocument(d,d.manifest.plan)).not.toThrow();
  expect(()=>validateDocument(d,{...d.manifest.plan,sourceRunIDs:["foreign"]})).toThrow();
  d.manifest.research.scope.kind="plan";expect(()=>validateDocument(d,d.manifest.plan)).toThrow();
});
it("existing whole-plan JSON envelope accepts a non-acquiring snapshot and retains exact source provenance",()=>{
  const value:any=exportFixture(id);value.plan={...plan(),selectedCount:3,counts:value.plan.counts};
  value.research.scope.kind="saved_snapshot";
  value.items.forEach((item:any)=>{item.childBatchId=null;});
  value.research.records.forEach((record:any)=>{record.runIds=["R1","R2"];});
  expect(()=>validatePlanMetadata(value,value.plan)).not.toThrow();
  expect(()=>validatePlanMetadata(value,{...value.plan,sourceRunIDs:["R2","foreign"]})).toThrow();
  value.research.scope.kind="plan";expect(()=>validatePlanMetadata(value,value.plan)).toThrow();
});
it("typed metadata busy/conflict advice does not invent a ZIP job or acquisition retry",()=>{
  expect(metadataFailure(new ApiError(429,"SYNTHETIC",7))).toContain("Wait at least 7 seconds");
  expect(metadataFailure(new ApiError(429,"SYNTHETIC",7))).not.toContain("ZIP");
  expect(metadataFailure(new ApiError(409,"SYNTHETIC"))).toContain("Refresh the snapshot");
});
afterEach(() => { models.splice(0).forEach(c => c.dispose()); vi.unstubAllGlobals(); clearSession(); });
it.each(["loss", "malformed"])("snapshot %s preserves UUID/body across run and draft changes; reopen is GET-only", async mode => {
  setSession({ csrf: "SYNTHETIC" }); const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { posts.push(String(init.body)); if (posts.length === 1) { if (mode === "loss") throw new Error("SYNTHETIC lost receipt"); return json({}); } return json(receipt); }
    return json(url.includes(id) ? page() : { plans: [plan()], offset: 0, limit: 25, total: 1 });
  }));
  const c = model(); await c.createSnapshot(members); c.changeRun("R3"); await c.createSnapshot([{ searchID: "changed", runIDs: ["R3"] }]); expect(posts).toHaveLength(1);
  await c.retrySubmission(); expect(posts[1]).toBe(posts[0]); expect(JSON.parse(posts[0])).toEqual({requestID:expect.any(String),scopeKind:"saved_snapshot",format:"pdf",members:[{searchID:"S1",runIDs:["R1","R2"]}]});
  expect(c.state.notice).toContain("No acquisition"); expect(c.changeRun("R4")).toBe(false); await c.read(id); await c.control("retry"); expect(posts).toHaveLength(2);
});
it("confirmed receipt/detail failure recovers only with GET; definitive409 never automatically retries", async () => {
  let mode = "detail503"; const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { if(init.method === "POST") { posts.push(String(init.body)); return mode === "409" ? json({},409) : json(receipt); } return url.includes(id) ? mode === "detail503" ? json({},503) : json(page()) : json({plans:[plan()],total:1,offset:0,limit:25}); }));
  const c=model();await c.createSnapshot(members);expect(c.state.confirmed?.planID).toBe(id);await c.createSnapshot(members);expect(posts).toHaveLength(1);mode="valid";await c.read(id);expect(posts).toHaveLength(1);
  mode="409";await c.createSnapshot([{searchID:"changed",runIDs:["R1"]}]);await c.retrySubmission();expect(posts).toHaveLength(2);expect(c.state.pending).toBeNull();
  expect(JSON.parse(posts[1]).requestID).not.toBe(JSON.parse(posts[0]).requestID);
  expect(JSON.parse(posts[1]).members).toEqual([{searchID:"changed",runIDs:["R1"]}]);
});
it.each([0,101])("snapshot rejects %d records before any network mutation",async count=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);const c=model();
  await c.createSnapshot(Array.from({length:count},(_,i)=>({searchID:`S${i}`,runIDs:["R1"]})));
  expect(fetch).not.toHaveBeenCalled();expect(c.state.pending).toBeNull();expect(c.state.error).toContain("100");
});
it.each([{...receipt,state:"active"},{...receipt,affectedCount:1},{...receipt,revision:0},{...receipt,selectedCount:2}])("rejects mismatched snapshot receipt %j", value => {
  expect(()=>validateCreateReceipt(value,{requestID:"synthetic",scopeKind:"saved_snapshot",format:"pdf",members})).toThrow();
});
it("rejects acquisition children/actions in snapshot detail",()=>{const d=page();d.plan.allowedActions=["retry"];expect(()=>validatePage(d)).toThrow();d.plan.allowedActions=[];d.items[0].childBatchID="unexpected" as never;expect(()=>validatePage(d)).toThrow();});
it.each([200,401,503])("stale snapshot%d body cannot expire replacement identity or publish",async status=>{
  setSession({csrf:"A"});let release!:(s:string)=>void,start!:()=>void;const started=new Promise<void>(r=>{start=r;});
  vi.stubGlobal("fetch",vi.fn(async()=>({status,ok:status===200,text:()=>{start();return new Promise<string>(r=>{release=r;});}})));
  const c=model(),old=c.read(id);await started;c.dispose();setSession({csrf:"B"});const g=sessionGeneration();release(JSON.stringify(status===200?page():{}));await old;expect(c.state.page).toBeNull();expect(sessionGeneration()).toBe(g);
});
it.each(["json","jsonl"] as const)("typed %s validates exact scope/count/Unicode and preserves bytes",async format=>{
  const research:any=exportFixture().research;research.scope.planId=id;research.scope.kind="saved_snapshot";research.records.forEach((r:any)=>{r.runIds=["R1","R2"];});
  const identity={...plan(),selectedCount:3};
  const bytes=format==="json"?JSON.stringify(research):[JSON.stringify({...research,type:"manifest",records:undefined}),...research.records.map((record:any)=>JSON.stringify({type:"record",record}))].join("\n")+"\n";
  const fetch=vi.fn(async()=>new Response(bytes,{headers:{"Content-Type":format==="json"?"application/json;charset=utf-8":"application/x-ndjson;charset=utf-8"}}));vi.stubGlobal("fetch",fetch);
  const result=await snapshotMetadata("L",identity,format,sessionGeneration(),new AbortController().signal);expect(await result.blob.text()).toBe(bytes);expect(result.filename).toBe(`litradock-saved-research.${format}`);
  expect(JSON.parse(String((fetch.mock.calls[0] as unknown[])[1] && ((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({format});
  await expect(snapshotMetadata("L",{...identity,planID:`PLN-${"2".repeat(32)}`},format,sessionGeneration(),new AbortController().signal)).rejects.toThrow();
});
it.each(["cancel","account"])("held metadata body is rejected after %s retirement",async mode=>{
  setSession({csrf:"A"});let feed!:ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({start(c){feed=c;}}),{headers:{"Content-Type":"text/csv"}})));
  const abort=new AbortController();const pending=snapshotMetadata("L",plan(),"csv",sessionGeneration(),abort.signal);const caught=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(feed).toBeDefined());if(mode==="cancel")abort.abort();else setSession({csrf:"B"});try{feed.enqueue(new TextEncoder().encode("Search ID,Title,Authors,Year,PMID,PMCID,DOI,\n"));feed.close();}catch{}await caught;
});
it.each(["empty","duplicate","foreign-run","missing-run","wrong-count","wrong-scope","wrong-kind","error-envelope"])("typed metadata rejects %s without returning a saveable blob",async defect=>{
  const research:any=exportFixture().research;research.scope.planId=id;
  research.scope.kind="saved_snapshot";
  research.records.forEach((record:any)=>{record.runIds=["R1","R2"];});
  if(defect==="empty")research.records=[];
  if(defect==="duplicate")research.records[1].searchId=research.records[0].searchId;
  if(defect==="foreign-run")research.records[0].runIds=["foreign"];
  if(defect==="missing-run")research.records.forEach((record:any)=>{record.runIds=["R1"];});
  if(defect==="wrong-count")research.counts.exportedRecords=2;
  if(defect==="wrong-scope")research.scope.selection="checked";
  if(defect==="wrong-kind")research.scope.kind="plan";
  if(defect==="error-envelope")research.error="SYNTHETIC";
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(research),{headers:{"Content-Type":"application/json"}})));
  await expect(snapshotMetadata("L",{...plan(),selectedCount:3},"json",sessionGeneration(),new AbortController().signal)).rejects.toThrow("No file was saved");
});
