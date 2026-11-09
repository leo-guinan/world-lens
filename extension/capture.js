// Serialized by chrome.scripting: keep self-contained and observation-only.
export function extractSelectedDocument(){
 const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
 const excluded='script,style,noscript,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]';
 const visible=element=>{
  if(!element||element.closest(excluded))return false;
  for(let node=element;node;node=node.parentElement){const css=getComputedStyle(node);if(css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse'||Number(css.opacity)===0)return false;}
  const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0;
 };
 const parts=[];let size=0;
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()&&size<12000){const node=walker.currentNode;if(!visible(node.parentElement))continue;const text=clean(node.textContent);if(text){parts.push(text.slice(0,12000-size));size+=text.length+1;}}
 const headings=[...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,30).map(e=>clean(e.innerText).slice(0,250));
 return {schema:'world-lens.selected-tab.v1',sourceKind:'user-selected-tab',observedAt:new Date().toISOString(),requestedUrl:location.href,finalUrl:location.href,status:null,title:clean(document.title).slice(0,300),text:parts.join('\n').slice(0,12000),headings,links:[],controls:[],actionsPerformed:['extract_visible_dom'],mutations:[],pageContentIsUntrusted:true,actionAuthorized:false,screenshotCaptured:false,boundary:'Manual local capture; may contain private visible page text. No automatic relay.'};
}
