import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PlaywrightBrowserPort } from "../src/world-lens.ts";
const out=process.env.PRODUCT_ARTIFACT_DIR;
assert.ok(out,"PRODUCT_ARTIFACT_DIR required");await mkdir(out,{recursive:true});
process.env.DATA_DIR=await mkdtemp(join(tmpdir(),'lens-product-'));
process.env.SERVER_AUTOLISTEN='0';
const original=PlaywrightBrowserPort.create;
const pages:any[]=[];let navigations=0;
// Harness-only interception; actual dispatcher, capture and persistence are unchanged.
PlaywrightBrowserPort.create=async()=>{
 const port=await original.call(PlaywrightBrowserPort);const page=(port as any).page;pages.push(page);
 await page.route('**/*',async(route:any)=>{
  if(route.request().url()!=='https://example.org/')return route.abort();navigations++;
  await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Local product fixture</title><p id="door">Door closed</p><script>setTimeout(()=>{document.querySelector("#door").textContent="Door open"},1800)</script>'});
 });return port;
};
const {server,shutdown}=await import('../src/server.ts');
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function post(path:string,body:unknown={}){const response=await fetch(base+path,{method:'POST',body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any}}
try{
 const opened=await post('/api/lens/sessions',{url:'https://example.org/'});assert.equal(opened.status,201);
 const path=`/api/lens/sessions/${opened.body.sessionId}/capture`;
 const first=await post(path);assert.equal(first.status,201);assert.match(first.body.text,/Door closed/);
 await pages[0].waitForFunction(()=>document.querySelector('#door')?.textContent==='Door open');
 const second=await post(path);assert.equal(second.status,201);assert.match(second.body.text,/Door open/);
 const repeat=await post(path);assert.equal(repeat.body.snapshotHash,second.body.snapshotHash);assert.equal(navigations,1);
 for(const receipt of [first.body,second.body,repeat.body]){
  const response=await fetch(base+`/api/lens/receipts/${receipt.id}`);assert.equal(response.status,200);assert.deepEqual(await response.json(),receipt);
  const screenshot=await fetch(base+receipt.screenshotUrl);assert.equal(screenshot.status,200);
  const bytes=Buffer.from(await screenshot.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.screenshotHash);
  await writeFile(join(out,`${receipt.id}.json`),JSON.stringify(receipt,null,2));await writeFile(join(out,`${receipt.id}.png`),bytes);
 }
 assert.equal(pages[0].isClosed(),false);
 await shutdown();assert.equal(server.listening,false);assert.equal(pages[0].isClosed(),true);await assert.rejects(()=>fetch(base+'/healthz'));
 const result={ok:true,scope:'actual product HTTP dispatcher and receipt/screenshot persistence over locally fulfilled Chromium document',navigations,captures:3,receiptIds:[first.body.id,second.body.id,repeat.body.id],screenshotHashesVerified:true,shutdownClosedTab:true,listenerStopped:true,broadcast:false};
 await writeFile(join(out,'product-session-receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{PlaywrightBrowserPort.create=original;await shutdown()}
