import assert from "node:assert/strict";
import { test } from "node:test";
import { RetainedBrowserSession } from "../src/retained-session.ts";

function fixture() {
 let navigations=0,closed=0,text="before";
 const browser={async navigate(url:string){navigations++;return {requestedUrl:url,finalUrl:url,status:200,title:"fixture"}},async currentLocation(){return "https://example.org/"},async extractVisible(){return {title:"fixture",text,headings:[],links:[],controls:[]}},async screenshot(){return Buffer.from("local fixture screenshot")},async close(){closed++}};
 return {browser,setText:(value:string)=>{text=value},counts:()=>({navigations,closed})};
}
test("retained captures observe one existing document without reloading or closing it",async()=>{
 const f=fixture();const session=await RetainedBrowserSession.open(f.browser,"https://example.org/");
 try{
  const first=await session.capture();f.setText("after");const second=await session.capture();const repeat=await session.capture();
  assert.equal(first.text,"before");assert.equal(second.text,"after");assert.equal(second.snapshotHash,repeat.snapshotHash);
  assert.deepEqual(f.counts(),{navigations:1,closed:0});
  assert.equal(second.sessionId,session.id);assert.equal(second.captureMode,"retained-tab");
  assert.deepEqual(second.actionsPerformed,["extract_visible_dom","screenshot"]);
 }finally{await session.close()}
 assert.deepEqual(f.counts(),{navigations:1,closed:1});await assert.rejects(()=>session.capture(),/closed/);
});
test("retained session rejects an unapproved navigation without extracting the new page",async()=>{
 const f=fixture();const session=await RetainedBrowserSession.open(f.browser,"https://example.org/");
 let extracted=false;f.browser.currentLocation=async()=>"https://other.example/";f.browser.extractVisible=async()=>{extracted=true;throw new Error("must not extract")};
 try{await assert.rejects(()=>session.capture(),/changed|navigation/i);assert.equal(extracted,false)}finally{await session.close()}
});
