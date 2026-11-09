import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { diffObservation, type ObservationReceiptLike } from "../src/live-observation.ts";

const receipt = (id: string, text: string): ObservationReceiptLike => ({ id, requestedUrl: "https://example.org/", finalUrl: "https://example.org/", status: 200, title: "Example", text, headings: [], links: [], controls: [], actionsPerformed: [], mutations: [] });
const change = (n: number) => diffObservation(receipt(`r${n}`, "alpha"), receipt(`r${n + 1}`, `alpha\nline ${n}`));

/** Read server-sent events until `count` messages have arrived (comments and keep-alives are skipped). */
async function readEvents(url: string, count: number, headers: Record<string, string> = {}, onOpen?: () => Promise<void>) {
  const control = new AbortController(), response = await fetch(url, { headers, signal: control.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const out: Array<{ id?: string; event?: string; data: any }> = []; let buffer = "", opened = false; const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      if (!opened) { opened = true; await onOpen?.(); }
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const message: { id?: string; event?: string; data?: string } = {};
        for (const line of block.split("\n")) { const m = line.match(/^(id|event|data): ?(.*)$/); if (m) (message as any)[m[1]] = m[2]; }
        if (message.data) out.push({ id: message.id, event: message.event, data: JSON.parse(message.data) });
        if (out.length >= count) { control.abort(); return out; }
      }
    }
  } catch (error) { if (!control.signal.aborted) throw error; }
  return out;
}

test("the live stream sends each change once, in order, and a returning consumer gets what it missed", async () => {
  process.env.SERVER_AUTOLISTEN = "0"; process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "lens-stream-"));
  const { server, feed, shutdown } = await import("../src/server.ts");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await feed.append(change(1), { title: "Example" });   // before anyone is listening
    // a new consumer is not handed the backlog: it hears only what happens next
    const live = await readEvents(`${base}/api/lens/live/stream`, 2, {}, async () => { await feed.append(change(2)); await feed.append(change(3)); });
    assert.deepEqual(live.map(m => [m.id, m.data.seq, m.data.signal.id]), [["2", 2, "r3"], ["3", 3, "r4"]]);
    assert.equal(live[0].data.signal.schema, "world-lens.signal.v1"); assert.equal(live[0].data.signal.data.pageContentIsUntrusted, true);
    assert.equal(live[0].data.event, undefined, "the stream carries the signal; the full change stays at /live/events");
    // it goes away, two more changes happen, it comes back with the last number it saw
    await feed.append(change(4)); await feed.append(change(5));
    const back = await readEvents(`${base}/api/lens/live/stream`, 2, { "last-event-id": "3" });
    assert.deepEqual(back.map(m => m.data.seq), [4, 5]);
    assert.deepEqual((await readEvents(`${base}/api/lens/live/stream?after=4`, 1)).map(m => m.data.seq), [5]);
    // the same record over plain HTTP, in the order it happened
    const listed = await (await fetch(`${base}/api/lens/live/events?after=2`)).json() as { events: any[]; signals: any[]; lastSeq: number };
    assert.deepEqual(listed.signals.map(s => s.data.seq), [3, 4, 5]); assert.equal(listed.lastSeq, 5); assert.equal(listed.events[0].schema, "world-lens.live-observation.v1");
    const health = await (await fetch(`${base}/healthz`)).json() as { live: { lastSeq: number } }; assert.equal(health.live.lastSeq, 5);
    // an open stream does not hold up shutdown
    const hanging = fetch(`${base}/api/lens/live/stream`).then(async r => { for await (const _ of r.body!) { /* until the server ends it */ } }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    const began = Date.now(); await shutdown({ deadlineMs: 3000 }); await hanging;
    assert.ok(Date.now() - began < 2000, "shutdown ended the stream instead of waiting for the deadline");
  } finally { await shutdown().catch(() => {}); }
});
