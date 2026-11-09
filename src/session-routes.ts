import type { IncomingMessage, ServerResponse } from "node:http";
import { RetainedBrowserSession } from "./retained-session.ts";

type Entry = { session: RetainedBrowserSession; createdAt: number; touchedAt: number; busy: boolean };
export function sessionRoutes(options: {
 open: (url:string)=>Promise<RetainedBrowserSession>;
 capture: (session:RetainedBrowserSession)=>Promise<unknown>;
 now?:()=>number; idleMs?:number; maxAgeMs?:number; sweepMs?:number; shutdownMs?:number;
}) {
 const sessions=new Map<string,Entry>();
 const pending=new Set<Promise<unknown>>();
 const now=options.now??Date.now;
 const idleMs=options.idleMs??600_000, maxAgeMs=options.maxAgeMs??3_600_000;
 let opening=0,closing=false;
 const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value))};
 async function sweep(){
  const expired=[...sessions.values()].filter(e=>!e.busy&&(now()-e.touchedAt>=idleMs||now()-e.createdAt>=maxAgeMs));
  for(const e of expired)sessions.delete(e.session.id);
  await Promise.all(expired.map(e=>e.session.close()));
 }
 const timer=options.sweepMs===0?undefined:setInterval(()=>{void sweep().catch(error=>console.error("Retained session expiry failed:",error instanceof Error?error.message:"unknown"))},options.sweepMs??15_000);
 timer?.unref();
 async function operate(req:IncomingMessage,res:ServerResponse,match:RegExpMatchArray){
  if(closing){json(res,503,{error:"Session service shutting down"});return}
  await sweep();
  if(closing){json(res,503,{error:"Session service shutting down"});return}
  if(!match[1]){
   if(sessions.size+opening>=4){json(res,429,{error:"Retained session capacity reached"});return}
   // Reserve capacity before reading the body so concurrent slow clients cannot exceed it.
   opening++;
   try{
    let body="";for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)throw new Error("Request too large")}
    const input=JSON.parse(body);if(typeof input.url!=="string")throw new Error("url required");
    if(closing){json(res,503,{error:"Session service shutting down"});return}
    const session=await options.open(input.url);
    if(closing){await session.close();json(res,503,{error:"Session service shutting down"});return}
    const time=now();sessions.set(session.id,{session,createdAt:time,touchedAt:time,busy:false});
    json(res,201,{sessionId:session.id,url:session.url,mode:"retained-tab",mutations:[]});
   }finally{opening--}
  }else{
   const entry=sessions.get(match[1]);if(!entry){json(res,404,{error:"Unknown session"});return}
   if(entry.busy){json(res,409,{error:"Session operation in progress"});return}
   if(match[2]==="close"){sessions.delete(entry.session.id);await entry.session.close();json(res,200,{closed:true,sessionId:entry.session.id})}
   else{
    entry.busy=true;
    try{const result=await options.capture(entry.session);if(closing){json(res,503,{error:"Session service shutting down"});return}entry.touchedAt=now();json(res,201,result)}finally{entry.busy=false}
   }
  }
 }
 return {
 async closeAll(){
  closing=true;if(timer)clearInterval(timer);
  const entries=[...sessions.values()];sessions.clear();
  // Close known browsers immediately, rather than waiting for their stalled captures.
  const cleanup=(async()=>{
   const results=await Promise.allSettled([...pending,...entries.map(e=>e.session.close())]);
   const failures=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected");
   if(failures.length)throw new AggregateError(failures.map(f=>f.reason),"Retained browser cleanup failed");
  })();
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([cleanup,new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error("Retained session shutdown deadline exceeded; cleanup incomplete")),options.shutdownMs??5000)})])}
  finally{if(deadline)clearTimeout(deadline)}
 },
 async handle(req:IncomingMessage,res:ServerResponse,path:string):Promise<boolean>{
  const match=path.match(/^\/api\/lens\/sessions(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(capture|close))?$/i);
  if(!match)return false;
  if(req.method!=="POST"){json(res,405,{error:"POST required"});return true}
  const peer=req.socket.remoteAddress,host=req.headers.host??"";
  if(req.headers.origin || !["127.0.0.1","::1","::ffff:127.0.0.1"].includes(peer??"") || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)){json(res,403,{error:"Session control requires a local non-browser client and loopback Host"});return true}
  const operation=operate(req,res,match);pending.add(operation);
  try{await operation}catch(error){json(res,422,{error:error instanceof Error?error.message:"Session operation failed"})}finally{pending.delete(operation)}
  return true;
 }
 };
}
