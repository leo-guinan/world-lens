import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { type ObservationReceiptLike } from "./live-observation.ts";
import { readReceipt, readScreenshot, storeReceipt, storeScreenshot, discardReceipt, saveObservers, readObservers, FEED_FILE, OBSERVATIONS } from "./receipt-store.ts";
import { observeUrl, parseTargetUrl, PlaywrightBrowserPort } from "./world-lens.ts";
import { LiveFeed, type FeedEntry } from "./live-feed.ts";
import { RetainedBrowserSession } from "./retained-session.ts";
import { sessionRoutes } from "./session-routes.ts";
import { LiveObserver } from "./live-observer.ts";

const PORT = Number(process.env.PORT || 8792);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(process.cwd(), "public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const MAX_BODY = 16_384;
const MAX_POLL_INTERVAL = 3600;
const MAX_LIVE_OBSERVERS = 8;
const MAX_STREAMS = 16;
const observers = new Map<string, LiveObserver>();
/** Every change the live observers see, in order. Consumers follow it at /api/lens/live/stream. */
export const feed = new LiveFeed(FEED_FILE, { legacyDir: OBSERVATIONS });
const feedReady = feed.load().catch(error => { console.error("Live feed could not be read:", error instanceof Error ? error.message : "unknown"); });
const streams = new Set<ServerResponse>();

/** Watch a page: poll it, keep the receipts that show a change, and put each change on the feed. */
async function startObserver(url: string, intervalSeconds: number) {
  const observer = new LiveObserver(async target => {
    let image: Buffer | undefined;
    const raw = await observeUrl(target, async (_id, png) => { image = png; return ""; });
    if (!image) throw new Error("Screenshot was not captured");
    const screenshot = await storeScreenshot(raw.id, image);
    const receipt = { ...raw, screenshotUrl: screenshot.url, screenshotHash: screenshot.sha256 };
    await storeReceipt(receipt);
    return receipt as ObservationReceiptLike;
  }, async () => {}, async (event, receipt) => {
    await feed.append(event, { title: receipt.title, screenshotUrl: `/api/lens/receipts/${receipt.id}/screenshot` });
  }, async duplicate => { await discardReceipt(duplicate.id); });
  observers.set(url, observer);
  try { return await observer.start(url, intervalSeconds); } catch (error) { observers.delete(url); throw error; }
}
const persistObservers = () => saveObservers([...observers.values()].map(o => o.getState()).filter(s => s.url && s.intervalSeconds).map(s => ({ url: s.url!, intervalSeconds: s.intervalSeconds! })))
  .catch(error => { console.error("Observer list could not be saved:", error instanceof Error ? error.message : "unknown"); });
const streamEntry = (entry: FeedEntry) => `id: ${entry.seq}\ndata: ${JSON.stringify({ seq: entry.seq, at: entry.at, signal: entry.signal })}\n\n`;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { ...NO_STORE, "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new Error("request too large"); chunks.push(chunk as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function staticFile(path: string, res: ServerResponse) {
  const file = normalize(join(PUBLIC, decodeURIComponent(path)));
  if (!file.startsWith(PUBLIC + "/") || !existsSync(file)) return json(res, 404, { error: "Not found" });
  res.writeHead(200, { ...NO_STORE, "content-type": MIME[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
}

const retainedSessions = sessionRoutes({
  open: async url => RetainedBrowserSession.open(await PlaywrightBrowserPort.create(), url),
  capture: async session => {
    let image: Buffer | undefined;
    const raw = await session.capture(async (_id,png)=>{image=png;return ""});
    if(!image)throw new Error("Screenshot was not captured");
    const shot=await storeScreenshot(raw.id,image);
    const receipt={...raw,screenshotUrl:shot.url,screenshotHash:shot.sha256};
    await storeReceipt(receipt);return receipt;
  },
});
export const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if(await retainedSessions.handle(req,res,url.pathname))return;
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, service: "world-lens", version: "0.1.0", mode: "observation-only", live: { observers: observers.size, lastSeq: feed.seq, streams: streams.size } });
    if (req.method === "GET" && url.pathname === "/api/lens/policy") return json(res, 200, { mode: "browser-observation", sourceKind: "browser", mutations: [], allowedSchemes: ["https"], queryParameters: false, allowedMethods: ["GET", "HEAD"], actions: ["navigate", "extract_visible_dom", "screenshot"], liveObserve: { enabled: true, minIntervalSeconds: 30, maxIntervalSeconds: 3600, changeEvent: "world-lens.live-observation.v1", signal: "world-lens.signal.v1", stream: "/api/lens/live/stream", pageContentIsUntrusted: true, actionsAuthorized: false }, maxBodyBytes: MAX_BODY, requiresApprovalToBrowse: true });
    if (req.method === "POST" && url.pathname === "/api/lens/live/start") {
      let input: any;
      try { input = await body(req); } catch { return json(res, 400, { error: "Invalid JSON or request body too large" }); }
      const interval = Number(input?.intervalSeconds);
      if (typeof input?.url !== "string") return json(res, 400, { error: "url is required" });
      if (!Number.isInteger(interval) || interval < 30 || interval > MAX_POLL_INTERVAL) return json(res, 400, { error: "intervalSeconds must be an integer from 30 to 3600" });
      try {
        const url = parseTargetUrl(input.url).toString();
        if (observers.has(url)) return json(res, 409, { error: "This URL already has a live observer" });
        if (observers.size >= MAX_LIVE_OBSERVERS) return json(res, 429, { error: "Live observer capacity reached" });
        const state = await startObserver(url, interval);
        await persistObservers();
        return json(res, 201, state);
      } catch (error) { return json(res, 422, { error: error instanceof Error ? error.message : "Live observation failed" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/lens/live/stop") {
      let input: any;
      try { input = await body(req); } catch { return json(res, 400, { error: "Invalid JSON or request body too large" }); }
      if (typeof input?.url !== "string") return json(res, 400, { error: "url is required" });
      try {
        const url = parseTargetUrl(input.url).toString();
        const observer = observers.get(url);
        if (!observer) return json(res, 404, { error: "No active observer for URL" });
        observer.stop(); observers.delete(url); await persistObservers();
        return json(res, 200, { stopped: true, url });
      } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid URL" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/lens/live/state") return json(res, 200, { observers: [...observers.values()].map(o => o.getState()) });
    if (req.method === "GET" && url.pathname === "/api/lens/live/events") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? 30);
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 30;
      await feedReady;
      // in the order they happened; with ?after=<seq>, only what came after that
      const after = Number(url.searchParams.get("after"));
      const entries = url.searchParams.has("after") && Number.isInteger(after) && after >= 0 ? feed.since(after, limit).entries : feed.latest(limit);
      return json(res, 200, { events: entries.map(entry => entry.event), signals: entries.map(entry => entry.signal), lastSeq: feed.seq });
    }
    if (req.method === "GET" && url.pathname === "/api/lens/live/stream") {
      // Server-sent events: one message per change, numbered. A client that reconnects sends the last number
      // it saw (Last-Event-ID, or ?after=) and gets what it missed; a new client gets only what happens next.
      if (streams.size >= MAX_STREAMS) return json(res, 429, { error: "Live stream capacity reached" });
      await feedReady;
      const cursor = req.headers["last-event-id"] ?? url.searchParams.get("after");
      const after = cursor === null || cursor === undefined || cursor === "" ? NaN : Number(cursor);
      res.writeHead(200, { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`: world-lens live stream, last seq ${feed.seq}\n\n`);
      if (Number.isInteger(after) && after >= 0) {
        const { entries, missed } = feed.since(after, 500);
        if (missed) res.write(`event: gap\ndata: ${JSON.stringify({ after, resumedAt: entries[0]?.seq ?? feed.seq })}\n\n`);
        for (const entry of entries) res.write(streamEntry(entry));
      }
      const unsubscribe = feed.subscribe(entry => { res.write(streamEntry(entry)); });
      const beat = setInterval(() => { res.write(": keep-alive\n\n"); }, 15_000);
      streams.add(res);
      req.on("close", () => { unsubscribe(); clearInterval(beat); streams.delete(res); });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lens/observe") {
      let input: any;
      try { input = await body(req); } catch { return json(res, 400, { error: "Invalid JSON or request body too large" }); }
      if (typeof input?.url !== "string") return json(res, 400, { error: "url is required" });
      try {
        let image: Buffer | undefined;
        const receipt = await observeUrl(input.url, async (id, png) => { image = png; return `/api/lens/receipts/${id}/screenshot`; });
        if (!image) throw new Error("Screenshot was not captured");
        const shot = await storeScreenshot(receipt.id, image);
        const stored = { ...receipt, screenshotUrl: shot.url, screenshotHash: shot.sha256 };
        await storeReceipt(stored);
        return json(res, 201, stored);
      } catch (error) { return json(res, 422, { error: error instanceof Error ? error.message : "Observation failed", sourceKind: "browser", actionsPerformed: [], mutations: [] }); }
    }
    const receiptMatch = url.pathname.match(/^\/api\/lens\/receipts\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && receiptMatch) {
      const receipt = await readReceipt(receiptMatch[1]);
      return receipt ? json(res, 200, receipt) : json(res, 404, { error: "Receipt not found" });
    }
    const imageMatch = url.pathname.match(/^\/api\/lens\/receipts\/([0-9a-f-]{36})\/screenshot$/i);
    if (req.method === "GET" && imageMatch) {
      const image = await readScreenshot(imageMatch[1]);
      if (!image) return json(res, 404, { error: "Screenshot not found" });
      res.writeHead(200, { ...NO_STORE, "content-type": "image/png", "content-length": image.length }); return res.end(image);
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return staticFile(url.pathname === "/" ? "/index.html" : url.pathname, res);
    return json(res, 404, { error: "Not found" });
  } catch (error) { console.error("request error:", error instanceof Error ? error.message : "unknown"); return json(res, 500, { error: "Internal error" }); }
});
let shutdownPromise: Promise<void> | undefined;
export function shutdown(options: {deadlineMs?:number} = {}): Promise<void> {
  if(shutdownPromise)return shutdownPromise;
  shutdownPromise=(async()=>{
    for(const observer of observers.values())observer.stop();
    observers.clear();
    for(const stream of streams)stream.end();
    streams.clear();
    await feed.idle();
    const stopped=server.listening?new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())):Promise.resolve();
    const cleanup=retainedSessions.closeAll();
    const drained=(async()=>{
      const results=await Promise.allSettled([stopped,cleanup]);
      const failures=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected");
      if(failures.length)throw new AggregateError(failures.map(f=>f.reason),"World Lens shutdown failed; cleanup incomplete");
    })();
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([drained,new Promise<never>((_resolve,reject)=>{
      deadline=setTimeout(()=>{server.closeAllConnections();reject(new Error("World Lens shutdown deadline exceeded; cleanup incomplete"))},options.deadlineMs??5000);
    })])}finally{if(deadline)clearTimeout(deadline)}
  })();
  return shutdownPromise;
}
if (process.env.SERVER_AUTOLISTEN !== "0") {
  server.listen(PORT, HOST, () => console.log(`World Lens listening on http://${HOST}:${PORT}`));
  // Pick up the pages that were being watched before the restart. Each starts with a new baseline, so a
  // restart never announces old news as a change.
  void (async () => {
    await feedReady;
    for (const saved of await readObservers()) {
      if (observers.has(saved.url) || observers.size >= MAX_LIVE_OBSERVERS) continue;
      try { await startObserver(parseTargetUrl(saved.url).toString(), Math.max(30, Math.min(MAX_POLL_INTERVAL, saved.intervalSeconds))); console.log(`Resumed live observer for ${saved.url}`); }
      catch (error) { console.error(`Could not resume live observer for ${saved.url}:`, error instanceof Error ? error.message : "unknown"); }
    }
  })();
  const stop=()=>{void shutdown().catch(error=>{console.error(error);process.exitCode=1})};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
}
