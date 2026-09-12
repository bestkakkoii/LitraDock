import assert from 'node:assert/strict';

export async function lateResponseFlow({context,origin,library,id,check,login,password}) {
  const isolated=await context.browser().newContext();
  let releaseNavigation;
  const watchdog=setTimeout(()=>{releaseNavigation?.();isolated.close().catch(()=>{});},90000);
  try {
    const signed=await isolated.request.post(origin+'/api/login',{headers:{Origin:origin},data:{login,password}});
    assert.equal(signed.status(),200);
    const token=(await signed.json()).csrf;
    const page=await isolated.newPage();
    page.on('pageerror',error=>console.log('RWR007 browser error: '+error.message));
    page.setDefaultTimeout(20000);
    // 僅測試頁匯出原始模組函式，未改寫函式；真實 Chromium 使用完整生產程式與 HTTP 回應。
    await page.route('**/hosted.js',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:(await response.text())+'\nwindow.__fence={download,api,privateFetch,safe};'});
    });
    await page.goto(origin);await page.waitForFunction(()=>Boolean(window.__fence));
    console.log('RWR007 production functions loaded');
    const detail=await (await isolated.request.get(origin+`/api/libraries/${library}/records/${id}`)).json();
    check(await page.evaluate(async library=>{
      await window.__fence.safe(()=>window.__fence.api(`libraries/${library}/search`,{query:'',limit:1}))();
      return document.querySelector('#error').textContent.length>0;
    },library),'RWR007 current-generation actual409 errors remain visible');
    const originalRoute=`libraries/${library}/records/${id}/files/${detail.files[0].hash}`;
    let downloads=0;page.on('download',()=>downloads++);
    // 先讓真實 headers/body 到達，僅延後瀏覽器 Promise 完成；伺服器已准入的操作可正常結束。
    await page.evaluate(()=>{
      window.__held=[];window.__release=[];window.__effects=0;window.__errors=[];
      for(const method of ['blob','json']) {
        const original=Response.prototype[method];
        Response.prototype[method]=async function(...args) {
          const result=await original.apply(this,args);
          if(this.url.includes('late-check=1')) {
            window.__held.push(this.url);
            await new Promise(resolve=>window.__release.push(resolve));
          }
          return result;
        };
      }
    });
    for(let n=0;n<4;n++) {
      await page.evaluate(({route,library,id,token,n})=>{
        const start=[
          ()=>window.__fence.download(route+'?late-check=1',undefined,'late-original.xml'),
          ()=>window.__fence.api('session?late-check=1').then(r=>r.json()),
          ()=>window.__fence.privateFetch('/api/restore?late-check=1',{method:'POST',headers:{Origin:location.origin,'X-CSRF':token,'Content-Type':'application/octet-stream'},body:new Uint8Array([1,2,3])}).then(r=>r.json()),
          ()=>window.__fence.privateFetch(`/api/libraries/${library}/records/${id}/manual/missing?late-check=1`,{method:'POST',headers:{Origin:location.origin,'X-CSRF':token,'Content-Type':'application/octet-stream'},body:new Uint8Array([1,2,3])}).then(r=>r.json()),
        ];
        (window.__tasks??=[]).push(start[n]().then(()=>window.__effects++).catch(e=>window.__errors.push(e.message)));
      },{route:originalRoute,library,id,token,n});
      await page.waitForFunction(count=>window.__held.length===count,n+1,{timeout:20000});
      console.log('RWR007 held real body completion '+(n+1));
    }
    await page.evaluate(library=>{
      window.__errorPending=window.__fence.safe(async()=>{
        try {await window.__fence.api(`libraries/${library}/search`,{query:'',limit:1});}
        catch(error){window.__heldError=error.message;await new Promise(resolve=>window.__errorRelease=resolve);throw error;}
      })();
    },library);
    await page.waitForFunction(()=>Boolean(window.__heldError));
    await page.evaluate(()=>document.querySelector('#error').textContent='Existing synthetic account error');
    const navigationHeld=new Promise(resolve=>releaseNavigation=resolve);
    await page.route(origin+'/',async route=>{await navigationHeld;await route.continue();});
    const logout=await isolated.request.post(origin+'/api/logout',{headers:{Origin:origin,'X-CSRF':token},data:{}});
    assert.equal(logout.status(),200);
    // 在 navigation 開始前安裝並執行觀察排程，避免 automation 本身等待被刻意扣留的新 document。
    const discarded=await page.evaluate(async()=>{
      await Promise.all([window.__fence.api('session'),window.__fence.api('session')].map(p=>p.catch(()=>{})));
      if(!document.querySelector('#workspace').hidden)throw Error('Private workspace did not clear after actual401');
      for(const release of window.__release)release();window.__errorRelease();await Promise.all(window.__tasks);await window.__errorPending;
      return window.__effects===0 && window.__errors.length===4 && document.querySelector('#error').textContent==='';
    });
    check(discarded,'RWR007 actual Chromium discards late download/API/manual/restore completion after observed401 while navigation is held');
    check(downloads===0,'RWR007 no stale browser download event after body release and repeated401');
    check(discarded,'RWR007 existing global error clears and delayed actual409 cannot render after observed401');
    releaseNavigation();
    await page.locator('#login').waitFor({state:'visible'});
  } finally {clearTimeout(watchdog);releaseNavigation?.();await isolated.close();}
}
