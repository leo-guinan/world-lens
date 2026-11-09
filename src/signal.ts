import type { ObservationChange, ObservationDelta } from "./live-observation.ts";

/** A change event, cut down to what a live consumer can use straight away: a few bounded lines of what
 * appeared and disappeared, and where the evidence is. It is the same untrusted evidence as the change
 * event, only smaller: nothing here is interpreted, ranked or summarised by a model. The shape
 * ({ id, kind, source, at, data }) is what fold's Director accepts as a signal. */
export interface LensSignal {
  schema: "world-lens.signal.v1";
  /** The receipt that showed the change. One signal per receipt. */
  id: string;
  kind: "lens.change";
  source: "world-lens";
  at: string;
  data: {
    seq: number;
    source: { url: string; host: string; title: string; receiptId: string; previousReceiptId: string | null; snapshotHash: string; screenshotUrl: string | null };
    summary: { added: number; removed: number; byKind: Record<string, number> };
    added: Array<{ kind: ObservationDelta["kind"]; value: string }>;
    removed: Array<{ kind: ObservationDelta["kind"]; value: string }>;
    /** True when the lists above leave out part of the delta. The full delta is in the change event. */
    truncated: boolean;
    pageContentIsUntrusted: true;
    actionAuthorized: false;
    interpretation: null;
  };
}

export const SIGNAL_LIMITS = { added: 12, removed: 6, valueChars: 240, titleChars: 200 } as const;
const ORDER: Record<ObservationDelta["kind"], number> = { title: 0, heading: 1, text: 2, link: 3, control: 4 };
const cut = (value: string, max: number) => { const s = value.replace(/\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s; };

export function toSignal(event: ObservationChange, seq: number, context: { title?: string; screenshotUrl?: string | null } = {}): LensSignal {
  // headlines before body text before links and controls; within a kind, page order
  const pick = (op: "added" | "removed", max: number) => event.delta
    .map((d, i) => ({ d, i })).filter(x => x.d.op === op)
    .sort((a, b) => ORDER[a.d.kind] - ORDER[b.d.kind] || a.i - b.i)
    .slice(0, max).map(({ d }) => ({ kind: d.kind, value: cut(d.value, SIGNAL_LIMITS.valueChars) }));
  const added = event.delta.filter(d => d.op === "added"), removed = event.delta.filter(d => d.op === "removed");
  const byKind: Record<string, number> = {}; for (const d of event.delta) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const a = pick("added", SIGNAL_LIMITS.added), r = pick("removed", SIGNAL_LIMITS.removed);
  let host = ""; try { host = new URL(event.finalUrl).hostname; } catch { /* keep empty */ }
  return {
    schema: "world-lens.signal.v1", id: event.sourceReceiptId, kind: "lens.change", source: "world-lens", at: event.observedAt,
    data: {
      seq,
      source: { url: event.finalUrl, host, title: cut(context.title ?? "", SIGNAL_LIMITS.titleChars), receiptId: event.sourceReceiptId, previousReceiptId: event.previousReceiptId, snapshotHash: event.snapshotHash, screenshotUrl: context.screenshotUrl ?? null },
      summary: { added: added.length, removed: removed.length, byKind },
      added: a, removed: r,
      truncated: a.length < added.length || r.length < removed.length || event.delta.some(d => d.value.replace(/\s+/g, " ").trim().length > SIGNAL_LIMITS.valueChars),
      pageContentIsUntrusted: true, actionAuthorized: false, interpretation: null,
    },
  };
}
