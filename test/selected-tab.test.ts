import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

test('selected-tab extractor bounds visible evidence and excludes form values and hidden text',async()=>{
 const {extractSelectedDocument}=await import(pathToFileURL(resolve('extension/capture.js')).href);
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<title>Local fixture</title><h1>Visible heading</h1><p>Visible evidence</p><p hidden>HIDDEN CANARY</p><input value="INPUT CANARY"><textarea>TEXTAREA CANARY</textarea><script>void "SCRIPT CANARY"</script>');
  const before=await page.content();
  const receipt=await page.evaluate(extractSelectedDocument) as {text:string;headings:string[];sourceKind:string;status:null;pageContentIsUntrusted:boolean;actionAuthorized:boolean;mutations:unknown[]};
  assert.match(receipt.text,/Visible evidence/);
  assert.doesNotMatch(receipt.text,/CANARY/);
  assert.deepEqual(receipt.headings,['Visible heading']);
  assert.equal(receipt.sourceKind,'user-selected-tab');assert.equal(receipt.status,null);
  assert.equal(receipt.pageContentIsUntrusted,true);assert.equal(receipt.actionAuthorized,false);
  assert.deepEqual(receipt.mutations,[]);assert.equal(await page.content(),before);
 }finally{await browser.close()}
});
test('selected-tab manifest has no persistent page or network permission',async()=>{
 const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));
 assert.deepEqual(manifest.permissions,['activeTab','scripting']);
 assert.equal(manifest.host_permissions,undefined);assert.equal(manifest.content_scripts,undefined);
});
