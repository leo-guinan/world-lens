import {extractSelectedDocument} from './capture.js';
const status=document.querySelector('#status'),preview=document.querySelector('#preview'),capture=document.querySelector('#capture'),save=document.querySelector('#export');
let receipt=null;
function clear(){receipt=null;preview.textContent='';save.disabled=true;status.textContent='No page captured.';}
document.querySelector('#clear').addEventListener('click',clear);
capture.addEventListener('click',async()=>{
 clear();capture.disabled=true;status.textContent='Capturing selected tab locally…';
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id)throw new Error('No selected tab.');
  const url=new URL(tab.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Select an HTTP(S) page without query, fragment or credentials.');
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractSelectedDocument});
  const value=results[0]?.result;
  const after=await chrome.tabs.get(tab.id);
  if(!value||value.finalUrl!==tab.url||after.url!==tab.url)throw new Error('Tab changed during capture; capture again.');
  receipt={...value,id:crypto.randomUUID()};
  const canonical=JSON.stringify({url:receipt.finalUrl,title:receipt.title,text:receipt.text,headings:receipt.headings});
  receipt.snapshotHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  preview.textContent=JSON.stringify(receipt,null,2);save.disabled=false;status.textContent='Captured locally. Review all text before export. Closing this popup discards it.';
 }catch(error){clear();status.textContent=error instanceof Error?error.message:'Capture failed.'}finally{capture.disabled=false;}
});
save.addEventListener('click',()=>{
 if(!receipt)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=`world-lens-selected-${receipt.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 status.textContent='Local export requested; no relay or broadcast.';
});
