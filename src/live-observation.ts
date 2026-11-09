import { createHash } from "node:crypto";
export interface LinkEvidence { text: string; href: string; locator: string }
export interface ControlEvidence { role: string; label: string; type?: string; locator: string; disabled?: boolean }
export interface ObservationReceiptLike {
  id: string; requestedUrl: string; finalUrl: string; status: number | null; title: string; text: string;
  headings: string[]; links: LinkEvidence[]; controls: ControlEvidence[]; actionsPerformed: string[]; mutations: unknown[];
}
export interface ObservationDelta { op: "added" | "removed"; kind: "title" | "text" | "heading" | "link" | "control"; value: string; locator: string }
export interface ObservationChange {
  schema: "world-lens.live-observation.v1"; kind: "baseline" | "unchanged" | "change"; changed: boolean;
  observedAt: string; sourceReceiptId: string; requestedUrl: string; finalUrl: string; status: number | null;
  previousReceiptId: string | null; previousHash: string | null; snapshotHash: string; delta: ObservationDelta[];
  actionsPerformed: [];
  mutations: [];
  pageContentIsUntrusted: true;
  actionAuthorized: false;
  interpretation: null;
  availableForLiveReaction: boolean;
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
function rows(r: ObservationReceiptLike): Array<{kind: ObservationDelta["kind"]; value:string; locator:string}> {
  const normalized: Array<{kind: ObservationDelta["kind"]; value:string; locator:string}> = [
    { kind:"title" as const, value:clean(r.title), locator:"document.title" },
    ...r.text.split(/\n+/).map(clean).filter(Boolean).map(value => ({kind:"text" as const,value,locator:"document.body.innerText"})),
    ...r.headings.map((value,i)=>({kind:"heading" as const,value:clean(value),locator:`heading[${i+1}]`})),
    ...r.links.map(x=>({kind:"link" as const,value:`${clean(x.text)} → ${x.href}`,locator:x.locator})),
    ...r.controls.map(x=>({kind:"control" as const,value:`${x.role}: ${clean(x.label)}${x.disabled ? " (disabled)" : ""}`,locator:x.locator})),
  ].map(x=>({...x,kind:x.kind as ObservationDelta["kind"]})).filter(x=>x.value.length>0);
  return normalized;
}
function hash(r: ObservationReceiptLike): string {
  const text=JSON.stringify(rows(r).map(({kind,value,locator})=>[kind,value,locator]));
  return createHash("sha256").update(text).digest("hex");
}
export function diffObservation(previous: ObservationReceiptLike | null,current: ObservationReceiptLike,observedAt=new Date().toISOString()): ObservationChange {
  const now=rows(current),then=previous?rows(previous):[];
  const key=(x:{kind:string;value:string;locator:string})=>JSON.stringify([x.kind,x.value,x.locator]);
  const oldSet=new Set(then.map(key)),newSet=new Set(now.map(key));
  const delta:ObservationDelta[]=previous?[
    ...now.filter(x=>!oldSet.has(key(x))).map(x=>({...x,op:"added" as const})),
    ...then.filter(x=>!newSet.has(key(x))).map(x=>({...x,op:"removed" as const})),
  ]:[];
  const changed=delta.length>0;
  return {schema:"world-lens.live-observation.v1",kind:previous?(changed?"change":"unchanged"):"baseline",changed,observedAt,
    sourceReceiptId:current.id,requestedUrl:current.requestedUrl,finalUrl:current.finalUrl,status:current.status,
    previousReceiptId:previous?.id??null,previousHash:previous?hash(previous):null,snapshotHash:hash(current),delta,
    actionsPerformed:[],mutations:[],pageContentIsUntrusted:true,actionAuthorized:false,interpretation:null,availableForLiveReaction:changed};
}
