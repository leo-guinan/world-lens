import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveObserver } from "../src/live-observer.ts";
import type { ObservationReceiptLike } from "../src/live-observation.ts";
const receipt=(id:string,text:string):ObservationReceiptLike=>({id,requestedUrl:"https://example.org/",finalUrl:"https://example.org/",status:200,title:"Example",text,headings:[],links:[],controls:[],actionsPerformed:["navigate","extract_visible_dom","screenshot"],mutations:[]});
test("live observer persists baseline, emits only source-linked changes, and stops",async()=>{
 const captures=[receipt("r1","alpha"),receipt("r2","alpha\nbeta"),receipt("r3","alpha\nbeta")];
 const stored:ObservationReceiptLike[]=[]; const events:any[]=[];
 const observer=new LiveObserver(async()=>captures.shift()!,async r=>{stored.push(r);},async e=>{events.push(e);});
 const state=await observer.start("https://example.org/",3600);
 assert.equal(state.polls,1); assert.equal(state.changes,0); assert.equal(events.length,0);
 await observer.pollOnce();
 assert.equal(stored.length,2); assert.equal(events.length,1); assert.equal(events[0].sourceReceiptId,"r2");
 assert.deepEqual(events[0].mutations,[]); assert.equal(events[0].pageContentIsUntrusted,true);
 await observer.pollOnce(); assert.equal(events.length,1); assert.equal(observer.getState().changes,1);
 observer.stop(); assert.equal(observer.getState().active,false);
});
test("a transient observation failure is surfaced and the next poll can recover",async()=>{
 let n=0; const events:any[]=[];
 const observer=new LiveObserver(async()=>{if(n++===0)throw new Error("fixture offline");return receipt("r2","changed");},async()=>{},async e=>{events.push(e);});
 await observer.start("https://example.org/",3600);
 assert.equal(observer.getState().lastError,"fixture offline");
 await observer.pollOnce(); assert.equal(events.length,0); assert.equal(observer.getState().polls,1);
 observer.stop();
});
