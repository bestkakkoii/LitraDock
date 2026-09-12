import {chromium} from 'playwright';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

if(process.env.LITRADOCK_ALLOW_EPHEMERAL_TEST!=='yes'||process.env.LITRADOCK_ALLOW_LIVE_SOURCE_PROBE!=='yes')
  throw new Error('Explicit disposable PostgreSQL and reviewed low-rate live-source authority required.');
const output=path.resolve(process.argv[2]||'.litradock/demo-live');await fs.mkdir(output,{recursive:true});
const root=process.cwd(),origin='http://127.0.0.1:5282',login='demo-'+Date.now(),password='Synthetic-demo-live-password-2026';
const dll=path.join(root,'build/LitraDock.Hosted/Release/net10.0/LitraDock.Hosted.dll'),cwd=path.join(root,'src/LitraDock.Hosted');
const env={...process.env,LITRADOCK_POSTGRES:process.env.LITRADOCK_PG_TEST_CONNECTION,LITRADOCK_OBJECTS:path.join(output,'private'),LITRADOCK_ORIGIN:origin,LITRADOCK_LOCAL_TEST:'true',LITRADOCK_PORT:'5282',LITRADOCK_INITIAL_LOGIN:login,LITRADOCK_INITIAL_PASSWORD:password,LITRADOCK_DEMO:'true',LITRADOCK_DEMO_OPERATOR:'Synthetic CI operator',LITRADOCK_DEMO_CONTACT:'No public service: disposable CI only',LITRADOCK_DEMO_RETENTION:'Destroyed with disposable CI runner; public evidence excludes account/query secrets and paper bytes',LITRADOCK_SOURCE_REVISION:process.env.GITHUB_SHA,LITRADOCK_DEMO_EXPIRES:new Date(Date.now()+3600000).toISOString()};
const run=promisify(execFile);for(const command of ['--migrate','--create-account'])await run('dotnet',[dll,command],{cwd,env,windowsHide:true});
await run('dotnet',[dll,'--create-account'],{cwd,env:{...env,LITRADOCK_INITIAL_LOGIN:login+'-other'},windowsHide:true});
let server,browser,page,admission;const checks=[],evidence={started:new Date().toISOString(),sourceRevision:env.LITRADOCK_SOURCE_REVISION,live:true,scope:'Production assembly, actual PostgreSQL/Chromium and low-rate PubMed/PMC; loopback HTTP only, no deployed HTTPS or actual mobile device'};
const check=(value,name)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){server=spawn('dotnet',[dll],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',()=>{});server.stderr.on('data',()=>{});for(let n=0;n<100;n++){try{if((await fetch(origin)).ok)return;}catch{}await delay(100);}throw new Error('Production demo did not start.');}
async function stop(){if(server?.exitCode==null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}}
try {
  await start();browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
  evidence.fileResponses=[];
  page.on('response',response=>{if(response.url().includes('/files/'))evidence.fileResponses.push({path:new URL(response.url()).pathname,status:response.status(),admission:response.headers()['x-operation-admission']??null});});
  await page.goto(origin);await page.locator('[name=login]').fill(login);await page.locator('[name=password]').fill(password);await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#serviceInformation').textContent.includes('Synthetic CI operator'));
  check(await page.locator('#researchTools').isHidden(),'DEMO11 production demo UI qualifies unsupported research features');
  await page.locator('#sourcePrivacy').evaluate(n=>n.open=true);
  check((await page.locator('#sourcePrivacy').innerText()).includes('NCBI disclaimer')&&(await page.locator('#serviceInformation').innerText()).includes('Destroyed with disposable CI runner'),'DEMO12 visible disclaimer/operator/source/privacy/retention facts');
  await page.locator('#sourcePrivacy').evaluate(n=>n.open=false);
  const csrf=(await (await context.request.get(origin+'/api/session')).json()).csrf;
  async function request(route,data,headers={}){for(let n=0;n<10;n++){const r=await context.request.fetch(origin+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'X-CSRF':csrf,...headers},...(data===undefined?{}:{data})});if(r.status()!==429||r.headers()['x-operation-admission']!=='not-started')return r;await delay(250);}throw new Error('Admission did not settle');}
  await page.locator('#newName').fill('Real source acceptance');await page.locator('#newLibrary').click();await page.waitForFunction(()=>document.querySelector('#libraries').value);
  const library=await page.locator('#libraries').inputValue(),base='libraries/'+library+'/';
  for(const [route,data] of [['restore',{}],[base+'bundle',{}],[base+'projects',{value:'Denied'}]])check((await request(route,data)).status()===403,'DEMO13 expensive feature denied at authenticated production boundary: '+route.split('/').at(-1));
  check((await request(base+'search',{query:'31719837',limit:101})).status()===409,'DEMO14 oversized real-source request denied before network');
  check((await context.request.post(origin+'/api/'+base+'search',{headers:{Origin:origin,'X-CSRF':'wrong'},data:{query:'31719837',limit:1}})).status()===403,'DEMO14 CSRF failure cannot queue live source work');
  await page.locator('#query').fill('31719837 OR 33782057 OR 31452104');await page.locator('#limit').fill('3');await page.locator('#search').click();
  let catalog;
  for(let n=0;n<150;n++){catalog=await (await request('libraries/'+library)).json();if(catalog.runs?.[0]&&['complete','partial','failed','unavailable'].includes(catalog.runs[0].state))break;await delay(1000);}
  evidence.run=catalog.runs?.[0];check(catalog.runs?.[0]?.total===3&&catalog.runs[0].fetched===3&&catalog.runs[0].state==='complete','DEMO15 actual PubMed three-identifier search completes without fixtures');
  await page.locator('#libraries').dispatchEvent('change');await page.waitForFunction(()=>document.querySelector('#runs').options.length>1);await page.locator('#runs').selectOption(catalog.runs[0].run_id);await page.locator('#runScope').click();await page.waitForFunction(()=>document.querySelectorAll('#records tr').length===3);
  const scope=await page.locator('#scopes').inputValue();const records=(await (await request(base+'scopes/'+scope)).json()).records;
  const reviewed=records.find(r=>r.article.pmid==='31719837'),second=records.find(r=>r.article.pmid==='33782057'),unreviewed=records.find(r=>r.article.pmid==='31452104');
  check(reviewed?.article.pmcid==='PMC6836491'&&reviewed.article.doi==='10.1186/s13020-019-0270-9'&&second?.article.pmcid==='PMC8005924'&&second.article.doi==='10.1136/bmj.n71'&&unreviewed,'DEMO15 separate original DOI PMID PMCID and three real records retained');
  for(const pmid of ['31719837','33782057','31452104'])await page.getByRole('checkbox',{name:'Select '+pmid,exact:true}).check();
  await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('selected 3'));await page.locator('#acquire').click();await page.waitForFunction(()=>document.querySelector('#batches').value);
  const batch=await page.locator('#batches').inputValue();let batchState;
  for(let n=0;n<180;n++){batchState=await (await request(base+'batches/'+batch)).json();if(['completed','completed_with_errors'].includes(batchState.state))break;await delay(1000);}
  evidence.batch=batchState;
  check(batchState.items.length===3&&batchState.items.find(x=>x.search_id===reviewed.article.searchId)?.state==='completed'&&batchState.items.find(x=>x.search_id===second.article.searchId)?.state==='completed'&&batchState.items.find(x=>x.search_id===unreviewed.article.searchId)?.state==='unavailable','DEMO16 actual three-item batch saves two distinct permitted papers and reports unreviewed item unavailable');
  const detail=await (await request(base+'records/'+reviewed.article.searchId)).json();const file=detail.files[0];evidence.original={hash:file.hash,kind:file.kind,provenance:detail.provenance};
  check(file.kind==='Source XML'&&detail.provenance.length>0,'DEMO17 actual original format and provider provenance retained');
  await page.locator('#records tr').filter({hasText:'31719837'}).getByRole('button').click();await page.locator('#detail').waitFor({state:'visible'});
  const heldDirectory=path.join(output,'admission-holder');await fs.mkdir(heldDirectory,{recursive:true});
  admission=spawn('dotnet',[path.join(root,'build/LitraDock.HostedVerification/Release/net10.0/LitraDock.HostedVerification.dll'),'--recovery-admission-hold',heldDirectory],{cwd:root,env,windowsHide:true,stdio:'ignore'});
  let held=false;for(let n=0;n<200;n++){try{await fs.access(path.join(heldDirectory,'held'));held=true;break;}catch{}await delay(25);}check(held,'DEMO26 actual PostgreSQL heavy admission held before device Save');
  const saving=page.waitForEvent('download');await page.locator('[data-file-hash="'+file.hash+'"]').click();const saved=await saving;await saved.saveAs(path.join(output,'private','saved-original.xml'));const bytes=await fs.readFile(path.join(output,'private','saved-original.xml'));
  check(evidence.fileResponses.some(r=>r.status===429&&r.admission==='not-started')&&evidence.fileResponses.filter(r=>r.status===200).length===1,'DEMO26 device Save retries only marked not-started admission and receives exactly one file');
  check(createHash('sha256').update(bytes).digest('hex')===file.hash&&saved.suggestedFilename().endsWith('.xml'),'DEMO18 actual browser device-Save preserves original bytes/hash and XML extension');
  check(bytes.includes(Buffer.from('creativecommons.org/licenses/by/4.0/')),'DEMO18 downloaded original retains its actual license URI');
  await page.locator('#close').click();
  const secondDetail=await (await request(base+'records/'+second.article.searchId)).json(),secondFile=secondDetail.files[0];
  evidence.secondOriginal={hash:secondFile.hash,kind:secondFile.kind,provenance:secondDetail.provenance};
  await page.locator('#records tr').filter({hasText:'33782057'}).getByRole('button').click();const secondSaving=page.waitForEvent('download');await page.locator('[data-file-hash="'+secondFile.hash+'"]').click();const secondSaved=await secondSaving,secondPath=path.join(output,'private','saved-prisma.xml');await secondSaved.saveAs(secondPath);const secondBytes=await fs.readFile(secondPath);
  check(secondFile.hash!==file.hash&&createHash('sha256').update(secondBytes).digest('hex')===secondFile.hash&&secondBytes.includes(Buffer.from('creativecommons.org/licenses/by/4.0/')),'DEMO18 second distinct article Save retains its own original hash and license');
  const offline=await browser.newContext({offline:true});const localPage=await offline.newPage();
  for(const [savedPath,pmcid] of [[path.join(output,'private','saved-original.xml'),'6836491'],[secondPath,'8005924']]){await localPage.goto(pathToFileURL(savedPath).href);check((await localPage.content()).includes(pmcid),'DEMO18 Chromium opens saved XML locally with networking disabled: PMC'+pmcid);}await offline.close();
  await page.locator('#close').click();await page.locator('#records tr').filter({hasText:'31452104'}).getByRole('button').click();
  await page.locator('#detail').waitFor({state:'visible'});
  check(await page.locator('#article a[href="https://pubmed.ncbi.nlm.nih.gov/31452104/"]').count()===1,'DEMO19 unresolved item offers convenient stable PubMed link');await page.locator('#close').click();
  const csvDownload=page.waitForEvent('download');await page.locator('#csv').click();const csv=await csvDownload;check(csv.suggestedFilename().endsWith('.zip'),'DEMO20 actual browser CSV export download is available');
  const anonymous=await browser.newContext(),foreign=await browser.newContext();
  const signed=await foreign.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login:login+'-other',password}});check(signed.status()===200,'DEMO21 second invited account signs in');
  const fileRoute=base+'records/'+reviewed.article.searchId+'/files/'+file.hash;
  check((await anonymous.request.get(origin+'/api/'+fileRoute)).status()===401&&(await foreign.request.get(origin+'/api/'+fileRoute)).status()===404,'DEMO21 anonymous and foreign accounts denied actual private original');await anonymous.close();await foreign.close();
  for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1000});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'DEMO22 responsive Chromium viewport '+width+' has no document overflow');await page.screenshot({path:path.join(output,'demo-'+width+'.png'),fullPage:true});}
  await stop();await start();
  const reopened=await (await request(base+'records/'+reviewed.article.searchId)).json();const again=await (await request(fileRoute)).body();
  check(reopened.files[0].hash===file.hash&&createHash('sha256').update(again).digest('hex')===file.hash,'DEMO23 actual server process restart retains database identity and original object hash');
  const logout=await request('logout',{});check(logout.status()===200&&(await request(fileRoute)).status()===401,'DEMO24 logout immediately denies future private original access');
  evidence.browser=await browser.version();evidence.node=process.version;evidence.platform=process.platform;
}catch(error){evidence.failure=String(error.stack||error);if(page){evidence.visibleErrors=await page.locator('#error,[data-request-error]').allTextContents().catch(()=>[]);await page.screenshot({path:path.join(output,'demo-failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally {if(admission?.exitCode==null)admission?.kill('SIGKILL');await fs.writeFile(path.join(output,'result.json'),JSON.stringify({...evidence,checks:checks.length,names:checks,finished:new Date().toISOString()},null,2));await browser?.close();await stop();}
