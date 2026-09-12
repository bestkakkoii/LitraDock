// Synthetic CI diagnostics only: no user source, credentials or document input.
import {chromium} from '../../src/document-worker/node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--disable-background-networking']});
console.log(JSON.stringify({browser:await browser.version(),node:process.version,platform:process.platform,sandboxRequested:true}));
await browser.close();
