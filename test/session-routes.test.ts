import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { sessionRoutes } from "../src/session-routes.ts";
import type { RetainedBrowserSession } from "../src/retained-session.ts";

async function fixture(options:Record<string,unknown>={}) {
 let now=0,closed=0,opened=0;
 const routes=sessionRoutes({now:()=>now,idleMs:100,maxAgeMs:250,sweepMs:0,
 open:async()=>({id:`00000000-0000-4000-8000-${String(++opened).padStart(12,"0")}`,url:"https://example.org/",close:async()=>{closed++}} as unknown as RetainedBrowserSession),
 capture:async()=>({ok:true}),...options} as Parameters<typeof sessionRoutes>[0]);
 const server=createServer(async(req,res)=>{if(!await routes.handle(req,res,new URL(req.url??"/","http://local").pathname)){res.writeHead(404);res.end()}});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const post=async(path:string,body:unknown={})=>{const r=await fetch(base+path,{method:"POST",body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any}};
 return {routes,post,setNow:(n:number)=>{now=n},closed:()=>closed,async cleanup(){await routes.closeAll();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}};
}
test("idle retained session expires before capture and releases its browser",async()=>{
 const f=await fixture();try{
  const opened=await f.post('/api/lens/sessions',{url:'https://example.org/'});
  f.setNow(101);const result=await f.post(`/api/lens/sessions/${opened.body.sessionId}/capture`);
  assert.equal(result.status,404);assert.equal(f.closed(),1);
 }finally{await f.cleanup()}
});
test("capture refreshes idle time but cannot extend maximum session age",async()=>{
 const f=await fixture();try{
  const opened=await f.post('/api/lens/sessions',{url:'https://example.org/'});const path=`/api/lens/sessions/${opened.body.sessionId}/capture`;
  f.setNow(90);assert.equal((await f.post(path)).status,201);
  f.setNow(180);assert.equal((await f.post(path)).status,201);
  f.setNow(251);assert.equal((await f.post(path)).status,404);assert.equal(f.closed(),1);
 }finally{await f.cleanup()}
});
test("background expiry closes idle tabs without another request",async()=>{
 const f=await fixture({sweepMs:5});try{
  await f.post('/api/lens/sessions',{url:'https://example.org/'});f.setNow(101);
  const deadline=Date.now()+1000;
  while(f.closed()===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.closed(),1);
 }finally{await f.cleanup()}
});
test("shutdown deadline reports a stalled open and still disposes its late browser",async()=>{
 let release!:()=>void,entered!:()=>void,closed=0;
 const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r});
 const f=await fixture({shutdownMs:20,open:async()=>{entered();await gate;return {id:'00000000-0000-4000-8000-000000000001',url:'https://example.org/',close:async()=>{closed++}}}});
 try{
  const opening=f.post('/api/lens/sessions',{url:'https://example.org/'});await started;
  const outcome=await Promise.race([f.routes.closeAll().then(()=> 'closed',e=>String(e)),new Promise<string>(r=>setTimeout(()=>r('watchdog'),200))]);
  assert.match(outcome,/deadline|timed out/i);
  release();assert.equal((await opening).status,503);assert.equal(closed,1);
 }finally{release();await f.cleanup()}
});
test("shutdown closes a retained browser even when its capture stalls",async()=>{
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r});
 const f=await fixture({shutdownMs:20,capture:async()=>{entered();await gate;return {ok:true}}});
 try{
  const opened=await f.post('/api/lens/sessions',{url:'https://example.org/'});
  const capturing=f.post(`/api/lens/sessions/${opened.body.sessionId}/capture`);await started;
  const outcome=await Promise.race([f.routes.closeAll().then(()=> 'closed',e=>String(e)),new Promise<string>(r=>setTimeout(()=>r('watchdog'),200))]);
  assert.match(outcome,/deadline|timed out/i);assert.equal(f.closed(),1);
  release();assert.equal((await capturing).status,503);
 }finally{release();await f.cleanup()}
});
test("shutdown rejects new sessions",async()=>{
 const f=await fixture();try{await f.routes.closeAll();assert.equal((await f.post('/api/lens/sessions',{url:'https://example.org/'})).status,503)}finally{await f.cleanup()}
});
test("shutdown drains an in-flight open and closes its browser instead of admitting it",async()=>{
 let release!:()=>void,entered!:()=>void,closed=0;
 const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r});
 const f=await fixture({open:async()=>{entered();await gate;return {id:'00000000-0000-4000-8000-000000000001',url:'https://example.org/',close:async()=>{closed++}}}});
 try{
  const opening=f.post('/api/lens/sessions',{url:'https://example.org/'});await started;
  const shutdown=f.routes.closeAll();release();await shutdown;
  assert.equal((await opening).status,503);assert.equal(closed,1);
 }finally{release();await f.cleanup()}
});
