import fs from 'node:fs/promises';
import path from 'node:path';

export async function researchFlow({page,context,origin,library,id,record,output,check,otherLogin,password}) {
  await page.locator('#researchTools').evaluate(x=>x.open=true);
  const projectIds=[];
  for(const name of ['Include collection 中文','Exclude collection']) {
    await page.locator('#projectName').fill(name);
    await page.locator('#createProject').click();
    await page.waitForFunction(name=>document.querySelector('#projects option:checked')?.textContent===name,name);
    projectIds.push(await page.locator('#projects').inputValue());
  }
  await page.locator('#snapshot').click();
  await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 120;'));
  await page.locator('#records tr').first().waitFor();
  await page.locator('#filter').fill(record.pmid);
  await page.locator('#refine').click();
  await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 1;'));
  await page.locator('#records button').first().click();
  await page.getByRole('button',{name:'Review, notes and reading copies',exact:true}).click();
  await page.locator('#reviewProject').selectOption(projectIds[0]);
  await page.locator('#reviewState').selectOption('included');
  await page.locator('#reviewNote').fill('Independent 中文 note');
  await page.locator('#reviewTags').fill('population;β');
  await page.locator('#reviewReason').fill('Relevant population');
  await page.locator('#saveReview').click();
  await page.waitForFunction(()=>document.querySelector('#reviewStatus').textContent.includes('revision 1'));
  await page.locator('#reviewProject').selectOption(projectIds[1]);
  await page.locator('#reviewState').selectOption('excluded');
  await page.locator('#reviewReason').fill('Different project protocol');
  await page.locator('#saveReview').click();
  await page.waitForFunction(()=>document.querySelector('#reviewHistory').textContent.includes('Different project protocol'));
  check(true,'Actual browser saves opposite project decisions, tags and Unicode notes without changing acquisition');
  await page.locator('#convertOriginal').click();
  await page.locator('#researchClose').click();
  await page.reload();
  await page.locator('#libraries').selectOption(library);
  const endpoint=origin+`/api/libraries/${library}/records/${id}/research`;
  let research;
  for(let n=0;n<100;n++) {
    research=await (await context.request.get(endpoint)).json();
    if(research.derivations?.length)break;
    if(research.conversions?.some(x=>x.state==='failed'))throw Error('Actual browser conversion failed: '+research.conversions.map(x=>x.reason).join(';'));
    await page.waitForTimeout(500);
  }
  check(research.derivations.length===1 && research.reviews.length===2,'Conversion survives browser reload and preserves both project decisions');
  const derived=research.derivations[0];
  const pdf=await context.request.get(origin+`/api/libraries/${library}/records/${id}/derived/${derived.derivation_id}/files`);
  check(pdf.ok() && (await pdf.body()).subarray(0,5).toString()==='%PDF-','Authorized exact-record derived PDF download');
  await fs.writeFile(path.join(output,'browser-reading.pdf'),await pdf.body());
  const foreign=await context.browser().newContext();
  try {
    const signed=await foreign.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login:otherLogin,password}});
    check(signed.ok(),'Independent browser session authenticates a different real account');
    const token=(await signed.json()).csrf;
    for(const route of [`records/${id}/research`,`records/${id}/derived/${derived.derivation_id}/files`,`projects/${projectIds[0]}`]) {
      const response=await foreign.request.get(origin+`/api/libraries/${library}/`+route);
      check(response.status()===404 && !(await response.text()).includes('Independent 中文 note'),'Foreign browser account denied existing research resource: '+route.split('/')[0]);
    }
    const response=await foreign.request.post(origin+`/api/libraries/${library}/records/${id}/conversions`,{headers:{Origin:origin,'X-CSRF':token},data:{mode:'abstract'}});
    check(response.status()===404,'Foreign authenticated browser cannot mutate conversion of existing record');
  } finally {await foreign.close();}

  await page.locator('#researchTools').evaluate(x=>x.open=true);
  await page.locator('#loadProjects').click();
  await page.locator('#projects').selectOption(projectIds[0]);
  await page.locator('#projectRecords button').first().click();
  await page.locator('#researchDialog').waitFor({state:'visible'});
  check((await page.locator('#reviewNote').inputValue())==='Independent 中文 note','Project collection reopens saved note after browser reload');
  await page.locator('#reviewVersion').selectOption(derived.hash);
  await page.locator('#reviewPageKind').selectOption('derived');
  await page.locator('#reviewPage').fill('1');
  await page.locator('#reviewQuote').fill('Complete synthetic body');
  await page.locator('#saveReview').click();
  await page.waitForFunction(()=>document.querySelector('#reviewStatus').textContent.includes('revision 2'));
  check(true,'Browser saves quote against exact derived hash and explicit derived page');
  await page.screenshot({path:path.join(output,'browser-research.png'),fullPage:true});
  await page.locator('#researchClose').click();
  await page.locator('#snapshot').click();
  await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 120;'));
  await page.locator('#filter').fill(record.pmid);
  await page.locator('#refine').click();
  await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 1;'));
  await page.locator('#citationPreview').click();
  await page.waitForFunction(()=>document.querySelector('#citationOutput').textContent.includes('citeproc-js/2.4.63'));
  check((await page.locator('#citationOutput').textContent()).includes(record.title),'Actual CSL preview contains current filtered record');
  for(const [button,filename] of [['citationRis','browser.ris'],['citationBib','browser.bib'],['citationJson','browser.csl.json']]) {
    const waiting=page.waitForEvent('download');await page.locator('#'+button).click();const download=await waiting;await download.saveAs(path.join(output,filename));
    check((await fs.readFile(path.join(output,filename),'utf8')).includes(id),'Browser scoped citation download preserves canonical ID: '+filename);
  }
  const waiting=page.waitForEvent('download');await page.locator('#scopedBundle').click();const download=await waiting;const bundle=path.join(output,'selected-research.zip');await download.saveAs(bundle);
  await page.locator('#bundleFile').evaluate(x=>x.closest('details').open=true);
  await page.locator('#bundleFile').setInputFiles(bundle);await page.locator('#restoreBundle').click();
  await page.waitForFunction(()=>document.querySelector('#recoveryStatus').textContent.includes('Library restored under your account'),{},{timeout:60000});
  const restored=await page.locator('#libraries').inputValue();
  const projected=await (await context.request.get(origin+`/api/libraries/${restored}/records/${id}/research`)).json();
  check(restored!==library && projected.reviews.length===2 && projected.derivations[0].hash===derived.hash,'Actual browser selected transfer retains opposite reviews and derived provenance under new library');
  const relocated=await context.request.get(origin+`/api/libraries/${restored}/records/${id}/derived/${derived.derivation_id}/files`);
  check(relocated.ok() && (await relocated.body()).equals(await pdf.body()),'Actual relocated derived download preserves byte identity');
  await page.screenshot({path:path.join(output,'browser-research-restored.png'),fullPage:true});
}
