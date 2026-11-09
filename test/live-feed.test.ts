import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveFeed } from "../src/live-feed.ts";
import { toSignal, SIGNAL_LIMITS } from "../src/signal.ts";
import { diffObservation, type ObservationReceiptLike } from "../src/live-observation.ts";
import { LiveObserver } from "../src/live-observer.ts";

const receipt = (id: string, text: string, extra: Partial<ObservationReceiptLike> = {}): ObservationReceiptLike => ({ id, requestedUrl: "https://example.org/", finalUrl: "https://example.org/news", status: 200, title: "Example", text, headings: [], links: [], controls: [], actionsPerformed: ["navigate", "extract_visible_dom", "screenshot"], mutations: [], ...extra });
const change = (n: number) => diffObservation(receipt(`r${n}`, "alpha"), receipt(`r${n + 1}`, `alpha\nline ${n}`), `2026-11-09T12:00:${String(n).padStart(2, "0")}.000Z`);

test("a signal is a bounded, ordered, uninterpreted cut of the change", () => {
  const long = "x".repeat(1000);
  const before = receipt("a", "kept");
  const after = receipt("b", ["kept", long, ...Array.from({ length: 30 }, (_, i) => `new line ${i}`)].join("\n"), {
    title: "Example — updated", headings: ["A new headline"], links: [{ text: "More", href: "https://example.org/more", locator: "#more" }],
  });
  const signal = toSignal(diffObservation(before, after, "2026-11-09T12:00:00.000Z"), 7, { title: "Example — updated", screenshotUrl: "/api/lens/receipts/b/screenshot" });
  assert.equal(signal.schema, "world-lens.signal.v1"); assert.equal(signal.id, "b"); assert.equal(signal.kind, "lens.change");
  assert.deepEqual(signal.data.source, { url: "https://example.org/news", host: "example.org", title: "Example — updated", receiptId: "b", previousReceiptId: "a", snapshotHash: signal.data.source.snapshotHash, screenshotUrl: "/api/lens/receipts/b/screenshot" });
  assert.equal(signal.data.added.length, SIGNAL_LIMITS.added);
  assert.deepEqual(signal.data.added.slice(0, 2).map(x => x.kind), ["title", "heading"], "headlines come before body text");
  assert.ok(signal.data.added.every(x => x.value.length <= SIGNAL_LIMITS.valueChars));
  assert.equal(signal.data.summary.added, 34); assert.equal(signal.data.summary.removed, 1, "the old title went");
  assert.equal(signal.data.truncated, true);
  assert.equal(signal.data.pageContentIsUntrusted, true); assert.equal(signal.data.actionAuthorized, false); assert.equal(signal.data.interpretation, null);
  assert.ok(JSON.stringify(signal).length < 6000, "small enough to pass along whole");
});

test("the feed numbers changes in order, delivers them live, and replays what a consumer missed", async () => {
  const feed = new LiveFeed(null, { keep: 5 }); const heard: number[] = [];
  const stop = feed.subscribe(entry => heard.push(entry.seq));
  const entries = await Promise.all([1, 2, 3].map(n => feed.append(change(n))));   // started together, still in order
  assert.deepEqual(entries.map(e => e.seq), [1, 2, 3]); assert.deepEqual(heard, [1, 2, 3]);
  assert.equal(entries[1].signal.data.seq, 2); assert.equal(entries[1].signal.id, "r3");
  assert.deepEqual(feed.since(1).entries.map(e => e.seq), [2, 3]); assert.equal(feed.since(1).missed, false);
  assert.deepEqual(feed.since(3), { entries: [], missed: false });
  stop(); for (const n of [4, 5, 6, 7, 8]) await feed.append(change(n));
  assert.deepEqual(heard, [1, 2, 3], "unsubscribed");
  const late = feed.since(1); assert.equal(late.missed, true, "2 and 3 are no longer held"); assert.deepEqual(late.entries.map(e => e.seq), [4, 5, 6, 7, 8]);
  assert.deepEqual(feed.latest(2).map(e => e.seq), [7, 8]);
});

test("the feed is a journal on disk: it survives a restart and a torn last line, and rotates when large", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lens-feed-")), file = join(dir, "live-feed.ndjson");
  const first = await new LiveFeed(file).load(); for (const n of [1, 2, 3]) await first.append(change(n));
  await appendFile(file, '{"seq":4,"at":"2026-11-09T12:0');   // the process died mid-write
  const second = await new LiveFeed(file).load();
  assert.equal(second.seq, 3); assert.deepEqual(second.latest().map(e => e.signal.id), ["r2", "r3", "r4"]);
  assert.equal((await second.append(change(4))).seq, 4, "numbering carries on");
  const small = await new LiveFeed(file, { rotateBytes: 10 }).load(); await small.append(change(5));
  const names = (await readdir(dir)).sort(); assert.deepEqual(names, ["live-feed-through-4.ndjson", "live-feed.ndjson"]);
  const kept = (await readFile(file, "utf8")).trim().split("\n"); assert.equal(kept.length, 1); assert.equal(JSON.parse(kept[0]).seq, 5);
});

test("changes stored one file each by an earlier version become the start of the journal, oldest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lens-legacy-")), legacy = join(dir, "observations"); await mkdir(legacy);
  const ids = ["cccccccc-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "bbbbbbbb-0000-4000-8000-000000000003"];
  for (const [i, id] of ids.entries()) await writeFile(join(legacy, `${id}.json`), JSON.stringify({ ...change(i + 1), sourceReceiptId: id }));
  const feed = await new LiveFeed(join(dir, "live-feed.ndjson"), { legacyDir: legacy }).load();
  assert.deepEqual(feed.latest().map(e => e.signal.id), ids, "by when they were observed, not by file name");
  assert.equal((await new LiveFeed(join(dir, "live-feed.ndjson"), { legacyDir: legacy }).load()).seq, 3, "imported once");
});

test("an observer told how to discard keeps only the receipts that showed something new", async () => {
  const captures = [receipt("r1", "alpha"), receipt("r2", "alpha"), receipt("r3", "alpha"), receipt("r4", "alpha\nbeta"), receipt("r5", "alpha\nbeta")];
  const discarded: string[] = [], changes: Array<{ from: string | null; to: string; title: string }> = [];
  const observer = new LiveObserver(async () => captures.shift()!, async () => {}, async (event, r) => { changes.push({ from: event.previousReceiptId, to: event.sourceReceiptId, title: r.title }); }, async duplicate => { discarded.push(duplicate.id); });
  await observer.start("https://example.org/", 3600);
  for (let i = 0; i < 4; i++) await observer.pollOnce();
  observer.stop();
  assert.deepEqual(discarded, ["r2", "r3", "r5"]);
  assert.deepEqual(changes, [{ from: "r1", to: "r4", title: "Example" }], "the change points at receipts that were kept");
  assert.equal(observer.getState().polls, 5); assert.equal(observer.getState().lastReceiptId, "r4");
});
