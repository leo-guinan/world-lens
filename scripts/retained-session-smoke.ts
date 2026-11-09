import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PlaywrightBrowserPort } from "../src/world-lens.ts";
import { RetainedBrowserSession } from "../src/retained-session.ts";
import { sessionRoutes } from "../src/session-routes.ts";
const out=process.env.RETAINED_ARTIFACT_DIR;
assert.ok(out,"RETAINED_ARTIFACT_DIR required");await mkdir(out,{recursive:true});
let navigations=0;let sourcePage:any;const receipts:any[]=[];
const routes=sessionRoutes({
 open:async url=>{
  const port=await PlaywrightBrowserPort.create();sourcePage=(port as any).page;
  await sourcePage.route("**/*",async(route:any)=>{navigations++;await route.fulfill({status:200,contentType:"text/html",body:'<!doctype html><title>Retained local fixture</title><p id="state">Door closed</p><script>setTimeout(()=>{document.querySelector("#state").textContent="Door open — same running document"},1800)</script>'})});
  return RetainedBrowserSession.open(port,url);
 },
 capture:async session=>{
  let hash="";const receipt=await session.capture(async(id,png)=>{hash=createHash("sha256").update(png).digest("hex");await writeFile(join(out,`${id}.png`),png);return `${id}.png`});
  const stored={...receipt,screenshotHash:hash};receipts.push(stored);await writeFile(join(out,`${receipt.id}.json`),JSON.stringify(stored,null,2));return stored;
 }
});
const server=createServer(async(req,res)=>{if(!await routes.handle(req,res,new URL(req.url??"/","http://local").pathname)){res.writeHead(404);res.end()}});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
async function post(path:string,body:any={},headers:Record<string,string>={}){const response=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any}}
try{
 assert.equal((await post('/api/lens/sessions',{url:'https://example.org/'},{origin:'https://evil.example'})).status,403);
 const opened=await post('/api/lens/sessions',{url:'https://example.org/'});assert.equal(opened.status,201);
 const prefix=`/api/lens/sessions/${opened.body.sessionId}`;
 const first=await post(prefix+'/capture');assert.equal(first.status,201);assert.match(first.body.text,/Door closed/);
 await sourcePage.waitForFunction(()=>document.querySelector('#state')?.textContent?.includes('Door open'));
 const second=await post(prefix+'/capture');const repeat=await post(prefix+'/capture');
 assert.match(second.body.text,/Door open/);assert.equal(second.body.snapshotHash,repeat.body.snapshotHash);
 assert.equal(second.body.screenshotHash,repeat.body.screenshotHash);assert.equal(navigations,1);
 assert.equal(second.body.sessionId,first.body.sessionId);assert.deepEqual(second.body.actionsPerformed,['extract_visible_dom','screenshot']);
 assert.equal((await post(prefix+'/close')).body.closed,true);assert.equal((await post(prefix+'/capture')).status,404);
 const result={ok:true,scope:'real Chromium retained isolated tab, controlled locally fulfilled HTTPS document, no external page content',navigations,captures:receipts.length,sessionId:opened.body.sessionId,sourceReceipts:receipts.map(r=>r.id),unchangedRepeat:true,closed:true,broadcast:false};
 await writeFile(join(out,'retained-session-receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await routes.closeAll();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
