import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const out=process.env.EXTENSION_ARTIFACT_DIR;assert.ok(out,'EXTENSION_ARTIFACT_DIR required');await mkdir(out,{recursive:true});
const profile=await mkdtemp(join(out,'disposable-profile-'));const extension=resolve('extension');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
try{
 const page=await context.newPage();await page.goto('chrome://extensions/');
 const extensions=await page.evaluate(()=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},resolve)));
 const installed=extensions.find(e=>e.name==='World Lens — Selected Tab');assert.ok(installed,'unpacked extension must actually be registered');assert.equal(installed.state,'ENABLED');
 const popup=await context.newPage();const errors=[];popup.on('pageerror',error=>errors.push(error.message));await popup.goto(`chrome-extension://${installed.id}/popup.html`);
 await popup.locator('#capture').waitFor();assert.equal(await popup.locator('#export').isDisabled(),true);assert.equal(await popup.locator('#preview').textContent(),'');
 await popup.screenshot({path:join(out,'selected-tab-popup.png')});assert.deepEqual(errors,[]);
 const receipt={ok:true,extensionId:installed.id,enabled:true,popupLoaded:true,noAutomaticCapture:true,pageErrors:errors,scope:'unpacked MV3 accepted in disposable Chromium; popup loaded; activeTab user gesture capture not exercised',personalProfileAccessed:false,networkRelay:false,broadcast:false};
 await writeFile(join(out,'extension-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await context.close()}
