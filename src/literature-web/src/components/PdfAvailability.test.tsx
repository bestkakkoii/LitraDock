// @vitest-environment jsdom
// Synthetic independent receipt schedules; no live-source claims.
import { act,useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { PdfAvailability } from './PdfAvailability';
import { ApiError,setSession,clearSession,sessionGeneration } from '../api';
import { PlanWorkspace } from '../plans/PlanWorkspace';

it.each([404,409,503])('a confirmed receipt followed by detail HTTP %i must never cause another POST',async status=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 setSession({csrf:'SYNTHETIC'});
 const admissions:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async (_url:string,init:RequestInit)=>{admissions.push(String(init.body));return new Response('{"id":"CONFIRMED-BATCH"}');}));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const scope=new AbortController();let reads=0;
 try {
  await act(async()=>root.render(<PdfAvailability selectedCount={1} ids={['SYNTHETIC-1']} ready enabled plansEnabled library='L1' runID='R1' generation={sessionGeneration()} scopeSignal={scope.signal} onBatch={async()=>{if(++reads===1)throw new ApiError(status,'SYNTHETIC detail failed');}}/>));
  await act(async()=>host.querySelector('button')!.click());
  expect(admissions).toHaveLength(1);
  await act(async()=>host.querySelector('button')!.click());
  expect(admissions,'Confirmed admission must survive a detail failure').toHaveLength(1);
 } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();clearSession();}
});

it('a confirmed PDF plan with failed initial detail retains GET-only recovery',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;setSession({csrf:'SYNTHETIC'});
 let posts=0;const scope=new AbortController(),ids=Array.from({length:11},(_,i)=>`SYNTHETIC-${i}`);
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  if(init.method==='POST'){posts++;return new Response('{"planID":"P1"}');}
  if(url.includes('/plans/P1'))return new Response('{"error":"SYNTHETIC detail failed"}',{status:503});
  return new Response('{"plans":[],"total":0,"offset":0,"limit":25}');
 }));
 function Harness(){const [open,setOpen]=useState<{id:string;sequence:number}>();return <>
  <PdfAvailability selectedCount={11} ids={ids} ready enabled plansEnabled library='L1' runID='R1' generation={sessionGeneration()} scopeSignal={scope.signal} onPlan={id=>setOpen(v=>({id,sequence:(v?.sequence??0)+1}))}/>
  <PlanWorkspace library='L1' runID='R1' generation={sessionGeneration()} selectedIDs={ids} enabled scopeSignal={scope.signal} onPlanChange={()=>{}} onChild={()=>{}} admissionReady openRequest={open}/>
 </>;}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{await act(async()=>root.render(<Harness/>));await act(async()=>host.querySelector('.pdf-availability button')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(host.textContent).toContain('Status unavailable');expect(posts).toBe(1);
  await act(async()=>host.querySelector('.pdf-availability button')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(posts,'Detail failure must not lose confirmed PDF plan receipt').toBe(1);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();clearSession();}
});
