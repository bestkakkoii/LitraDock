import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export async function identityFlow({page,context,origin,library,id,record,output,check,otherLogin,login,password,account,dll,cwd,env}) {
  const logs=[];
  async function operator(action, allowBusy=false) {
    for(let attempt=0;attempt<10;attempt++) {
      try {
        const result=await promisify(execFile)('dotnet',[dll,'--account-control'],{cwd,env:{...env,LITRADOCK_ACCOUNT_ID:account,LITRADOCK_ACCOUNT_ACTION:action},windowsHide:true,timeout:15000});
        logs.push(result.stdout,result.stderr);return {ok:true,text:result.stdout};
      } catch(error) {
        const text=(error.stdout||'')+(error.stderr||'');logs.push(text);
        if(!text.includes('"reason":"busy"'))throw error;
        if(allowBusy)return {ok:false,text};
        if(attempt===9)throw error;
        // 只在收到明確未執行 busy 結果後重試，不重播不明操作。
        await new Promise(r=>setTimeout(r,100));
      }
    }
  }
  async function waitFile(name) {
    const until=Date.now()+10000;
    while(Date.now()<until) {try {await fs.access(path.join(output,name));return;}catch{} await new Promise(r=>setTimeout(r,20));}
    throw Error('Identity barrier did not arrive: '+name);
  }
  const second=await context.browser().newContext(), other=await context.browser().newContext();
  try {
    const signed=await second.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login,password}});
    check(signed.ok(),'IDA01 second real browser context signs into target account');
    const otherSigned=await other.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login:otherLogin,password}});
    check(otherSigned.ok(),'IDA01 independent browser account signs in');
    const csrf=(await signed.json()).csrf;
    const baseline=await (await context.request.get(origin+`/api/libraries/${library}/records/${id}/research`)).json();
    const detail=await (await context.request.get(origin+`/api/libraries/${library}/records/${id}`)).json();
    const originalRoute=`libraries/${library}/records/${id}/files/${detail.files[0].hash}`;
    const derivedRoute=`libraries/${library}/records/${id}/derived/${baseline.derivations[0].derivation_id}/files`;
    const original=await (await context.request.get(origin+'/api/'+originalRoute)).body();
    await page.locator('#libraries').selectOption(library);
    await page.locator('#snapshot').click();await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 120;'));
    await page.locator('#filter').fill(record.pmid);await page.locator('#refine').click();await page.waitForFunction(()=>document.querySelector('#counts').textContent.includes('Scope 1;'));
    const scope=await page.locator('#scopes').inputValue();
    await page.locator('#researchTools').evaluate(x=>x.open=true);
    await page.locator('#citationRis').click();await page.locator('#citationSave').waitFor({state:'visible'});
    const blob=await page.locator('#citationSave').getAttribute('href');
    check(blob.startsWith('blob:'),'IDA06 actual browser prepares private citation bytes before revocation');

    // HTTP 在初次驗證後停住，另一操作程序完成撤銷，釋放後必須重新驗證。
    const pending=second.request.get(origin+'/api/session',{headers:{'X-Identity-Barrier':'before-admission'}});
    await waitFile('before-admission.ready');
    check((await operator('revoke-sessions')).ok,'IDA05 independent operator commits while authenticated request awaits admission');
    await fs.writeFile(path.join(output,'before-admission.release'),'release');
    check((await pending).status()===401,'IDA05 delayed HTTP request rejects stale authentication after admission');
    const observed=page.waitForResponse(r=>r.url()===origin+'/api/transfers' && r.status()===401);
    await page.locator('#bundleFile').evaluate(x=>x.closest('details').open=true);
    await page.locator('#transferHistory').click();await observed;
    await page.locator('#login').waitFor({state:'visible'});
    check(await page.locator('#citationSave').getAttribute('href')===null && (await page.locator('#citationOutput').textContent())==='' && await page.locator('#projectRecords button').count()===0 && !(await page.content()).includes('Independent 中文 note'), 'IDA06 observed browser401 clears private DOM and prepared citation URL');
    check(await page.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},blob),'IDA06 former prepared blob URL is no longer usable in the new document');
    for(const route of ['session',originalRoute,derivedRoute])
      check((await second.request.get(origin+'/api/'+route)).status()===401,'IDA01 revoked context cannot access '+route.split('/').at(-1));
    for(const [route,data] of [[`libraries/${library}/scopes/${scope}/citations`,{style:'vancouver',format:'ris'}],[`libraries/${library}/bundle`,{}],['libraries',{value:'Must not create'}]])
      check((await second.request.post(origin+'/api/'+route,{headers:{Origin:origin,'X-CSRF':csrf},data})).status()===401,'IDA01 revoked citation/bundle/mutation denied: '+route.split('/').at(-1));
    check((await other.request.get(origin+'/api/session')).ok(),'IDA01 independent account remains usable');
    await page.locator('[name="login"]').fill(login);await page.locator('[name="password"]').fill(password);await page.locator('#login button').click();await page.locator('#workspace').waitFor({state:'visible'});
    const admitted=context.request.get(origin+'/api/session',{headers:{'X-Identity-Barrier':'after-admission'}});
    await waitFile('after-admission.ready');
    check(!(await operator('disable',true)).ok,'IDA05 already admitted HTTP operation forces explicit operator busy failure');
    await fs.writeFile(path.join(output,'after-admission.release'),'release');
    check((await admitted).ok(),'IDA05 already admitted request completes before a later successful disable');
    check((await operator('disable')).ok,'IDA01 disable succeeds after active request drains');
    check((await context.request.get(origin+'/api/session')).status()===401 && (await second.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login,password}})).status()===401,'IDA01 disabled account denies active token and password login');
    check((await operator('enable')).ok,'IDA02 enable succeeds without reviving old tokens');
    check((await context.request.get(origin+'/api/session')).status()===401 && (await second.request.get(origin+'/api/session')).status()===401,'IDA02 all pre-enable browser tokens remain denied');
    const fresh=await second.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login,password}});
    check(fresh.ok(),'IDA02 new normal login succeeds after enable');
    const after=await (await second.request.get(origin+`/api/libraries/${library}/records/${id}/research`)).json();
    check(JSON.stringify(after)===JSON.stringify(baseline) && (await (await second.request.get(origin+'/api/'+originalRoute)).body()).equals(original),'IDA07 browser re-login preserves exact research graph and original bytes');
    check(!logs.join('\n').includes(password) && !logs.join('\n').includes(csrf),'IDA07 operator context logs exclude browser password and CSRF');
    await fs.writeFile(path.join(output,'identity-operator-results.json'),JSON.stringify(logs));
    await page.reload();await page.locator('#login').waitFor({state:'visible'});
  } finally {await second.close();await other.close();}
}
