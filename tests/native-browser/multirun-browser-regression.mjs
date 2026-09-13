// Actual native handlers/PostgreSQL/compiled React with explicitly synthetic transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';

const inputPath = process.env.NATIVE_BROWSER_INPUT;
assert(inputPath && !inputPath.trimStart().startsWith('{'));
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const target = process.env.NATIVE_BROWSER_URL;
const origin = new URL(target);
assert.equal(origin.protocol, 'http:');
assert(['127.0.0.1', 'localhost'].includes(origin.hostname));
assert.equal(input.origin, target);
assert(/^[0-9a-f]{40}$/.test(input.source_revision));
const manifest = JSON.parse(fs.readFileSync(input.manifest, 'utf8'));
assert.equal(manifest.source_revision, input.source_revision);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({acceptDownloads:true, viewport:{width:1280,height:800}});
await context.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors=[], checks=[], posts=[];
page.on('pageerror', e=>errors.push(e.message));
page.on('request', r=>{if(r.method()==='POST' && /\/(search|batches|plans|control)$/.test(r.url()))posts.push({url:r.url(),body:r.postDataJSON()});});
const check=async(name, fn)=>{await fn();checks.push({name,pass:true});};
const until=async(fn, reason)=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error(reason);};
let lastLogin=0, library='', plan='', runA='', runB='', expected=[];
const plans=page.getByRole('region',{name:'Processing plans',exact:true});
const basket=page.getByRole('region',{name:'Saved-record basket',exact:true});
const login=async(account=input.accounts[0])=>{
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-lastLogin))));
  await page.getByLabel('Login',{exact:true}).fill(account.login);
  await page.getByLabel('Password',{exact:true}).fill(account.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Choose library',{exact:true}).waitFor();lastLogin=Date.now();
};
const detail=async()=>{const r=await page.request.get(`${target}/api/libraries/${library}/plans/${plan}?limit=100`);assert.equal(r.status(),200);return r.json();};
const search=async(query,count)=>{
  await page.getByLabel('Query',{exact:true}).fill(query);
  await page.getByRole('button',{name:'Search PubMed',exact:true}).click();
  await until(async()=>{const text=await page.locator('body').innerText();return text.includes(`retrieved ${count} of`) && text.includes(query);},'saved search complete');
  const run=(await page.locator('.query-snapshot .small').innerText()).replace('Search Run ID: ','');
  const r=await page.request.get(`${target}/api/libraries/${library}/runs/${run}?limit=100`);
  assert.equal(r.status(),200);return {run,data:await r.json()};
};
try {
  await page.goto(target);
  await check('compiled-assets-and-schema4-capability',async()=>{
    const info=await (await page.request.get(target+'/service-info')).json();
    assert.equal(info.savedSetEnabled,true);
    assert.equal(info.source,`https://github.com/bestkakkoii/LitraDock/tree/${input.source_revision}`);
    for(const [name,want] of Object.entries(manifest.files).filter(([n])=>n.startsWith('web/'))){const r=await page.request.get(target+'/'+(name==='web/index.html'?'':name.slice(4)));assert.equal(hash(await r.body()),want);}
  });
  await login();
  await page.getByLabel('New library name',{exact:true}).fill('SYNTHETIC multi-run browser');
  await page.getByRole('button',{name:'Create',exact:true}).click();
  await until(async()=>!!await page.getByLabel('Choose library',{exact:true}).inputValue(),'library');
  library=await page.getByLabel('Choose library',{exact:true}).inputValue();
  await check('two-real-saved-run-rows-stable-dedup-and-query-associations',async()=>{
    const first=await search('SYNTHETIC_FIRST_RUN',3);runA=first.run;
    assert.equal(first.data.run.total,25000);assert.equal(first.data.total,3);
    await basket.getByRole('button',{name:'Add checked records to basket (3)',exact:true}).click();
    expected=first.data.records.map(r=>({searchID:r.SearchId,runIDs:[runA]}));
    const second=await search('SYNTHETIC_SECOND_RUN',2);runB=second.run;
    assert.notEqual(runA,runB);assert.equal(second.data.run.total,10001);assert.equal(second.data.total,2);
    await basket.getByRole('button',{name:'Add checked records to basket (2)',exact:true}).click();
    for(const r of second.data.records){const m=expected.find(x=>x.searchID===r.SearchId);assert(m);m.runIDs.push(runB);m.runIDs.sort();}
    assert((await basket.innerText()).includes('3 records in basket · 2 saved searches'));
    await basket.getByLabel('Basket original format',{exact:true}).selectOption('xml');
  });
  await check('lost-response-same-intent-single-durable-plan',async()=>{
    const endpoint=`${target}/api/libraries/${library}/plans`;
    let lost=false;
    await page.route(endpoint,async route=>{
      if(route.request().method()!=='POST'||lost)return route.continue();
      lost=true;const response=await route.fetch();assert.equal(response.status(),200);plan=(await response.json()).planID;await route.abort('failed');
    });
    await basket.getByRole('button',{name:'Download basket XMLs (3)',exact:true}).click();
    await plans.getByRole('button',{name:'Retry same submission',exact:true}).click();
    await plans.getByRole('heading',{name:'Plan '+plan,exact:true}).waitFor();
    await page.unroute(endpoint);
    const admissions=posts.filter(p=>p.url.endsWith('/plans'));
    assert.equal(admissions.length,2);assert.deepEqual(admissions[0],admissions[1]);
    assert.deepEqual(admissions[0].body.members,expected);
    const p=await detail();assert.equal(p.plan.scopeKind,'saved_set');assert.equal(p.plan.runID,'');
    assert.deepEqual(p.plan.sourceRunIDs,[runA,runB].sort());
    assert.deepEqual(p.items.map(i=>({searchID:i.searchID,runIDs:i.runIDs})),expected);
    assert.equal((await (await page.request.get(endpoint)).json()).total,1);
  });
  await check('native-mixed-progress-and-frozen-export-after-run-change',async()=>{
    fs.writeFileSync(input.source_gate,'release synthetic source only');
    await until(async()=>{const p=await detail();return p.plan.counts.completed===2&&p.plan.counts.held===1;},'mixed final phases');
    const before=JSON.stringify(posts);
    await page.getByRole('list',{name:'Saved searches',exact:true}).getByRole('button').filter({hasText:runA}).click();
    await plans.getByRole('heading',{name:'Plan '+plan,exact:true}).waitFor();
    assert.equal(JSON.stringify(posts),before,'opening saved run must not acquire');
    const intentFile=inputPath+'.intent.json';fs.writeFileSync(intentFile,JSON.stringify(expected));
    for(const [label,format] of [['Export plan metadata JSON','json'],['Save plan originals ZIP','zip']]){
      const started=Date.now(),wait=page.waitForEvent('download');
      await plans.getByRole('button',{name:label,exact:true}).click();
      const download=await wait;assert.equal(await download.failure(),null);
      const filename=inputPath+'.download.'+format;await download.saveAs(filename);
      const raw=fs.readFileSync(filename);
      const reader=execFileSync('python3',[fileURLToPath(new URL('./verify-plan-export.py',import.meta.url)),filename,'--expected-saved-set',intentFile,'--negative-controls'],{encoding:'utf8'});
      assert.equal(JSON.parse(reader).pass,true);
      if(format==='zip'){
        const entries=unzipSync(raw),m=JSON.parse(new TextDecoder().decode(entries['manifest.json']));
        assert.equal(m.counts.includedRecords,2);assert.equal(m.counts.unresolvedRecords,1);assert.equal(m.counts.uniqueOriginals,2);
        for(const wanted of input.originals){const item=m.research.records.find(r=>r.identifiers.pmid===wanted.pmid);assert(item);const association=m.items.find(i=>i.searchId===item.searchId);assert.equal(hash(entries[association.file]),wanted.sha256);}
      }
      checks.push({name:'device-'+format,bytes:raw.length,sha256:hash(raw),milliseconds:Date.now()-started,pass:true});
    }
    assert.equal(JSON.stringify(posts),before,'exports must not acquire');
  });
  await check('narrow-layout-reload-relogin-and-foreign-scope',async()=>{
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const before=JSON.stringify(posts);
    await page.reload();await page.getByLabel('Choose library',{exact:true}).selectOption(library);
    await page.getByLabel('Saved plans',{exact:true}).selectOption(plan);
    await plans.getByRole('heading',{name:'Plan '+plan,exact:true}).waitFor();
    assert((await basket.innerText()).includes('0 records in basket'));
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(input.accounts[1]);
    assert.equal((await page.request.get(`${target}/api/libraries/${library}/plans/${plan}`)).status(),404);
    assert(!(await page.locator('body').innerText()).includes(plan));
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await login();
    await page.getByLabel('Choose library',{exact:true}).selectOption(library);
    await page.getByLabel('Saved plans',{exact:true}).selectOption(plan);
    await plans.getByRole('heading',{name:'Plan '+plan,exact:true}).waitFor();
    assert.equal(JSON.stringify(posts),before);
  });
  assert.deepEqual(errors,[]);assert.equal(posts.filter(p=>p.url.endsWith('/batches')).length,0);
  console.log(JSON.stringify({scope:'SYNTHETIC transport only; actual native PostgreSQL and pinned compiled React',source_revision:input.source_revision,checks,selected:3,sourceRuns:2,providerTotals:[25000,10001],retrieved:[3,2]}));
}catch(e){console.error(JSON.stringify({checks,body:await page.locator('body').innerText()}));throw e;}
finally{await context.close();await browser.close();}
