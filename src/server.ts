import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { diffObservation, type ObservationReceiptLike, type ObservationChange } from "./live-observation.ts";
import { readReceipt, readScreenshot, storeReceipt, storeScreenshot, storeObservationEvent, readObservationEvents } from "./receipt-store.ts";
import { observeUrl, PlaywrightBrowserPort } from "./world-lens.ts";
import { RetainedBrowserSession } from "./retained-session.ts";
import { sessionRoutes } from "./session-routes.ts";
import { LiveObserver } from "./live-observer.ts";
import { packFromReceipt } from "../lib/evidence.js";

const PORT = Number(process.env.PORT || 8792);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(process.cwd(), "public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const MAX_BODY = 16_384;
const MAX_POLL_INTERVAL = 3600;
const MAX_LIVE_OBSERVERS = 8;
const observers = new Map<string, LiveObserver>();
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
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, service: "world-lens", version: "0.1.0", mode: "observation-only" });
    if (req.method === "GET" && url.pathname === "/api/lens/policy") return json(res, 200, { mode: "browser-observation", sourceKind: "browser", mutations: [], allowedSchemes: ["https"], queryParameters: false, allowedMethods: ["GET", "HEAD"], actions: ["navigate", "extract_visible_dom", "screenshot"], liveObserve: { enabled: true, minIntervalSeconds: 30, maxIntervalSeconds: 3600, changeEvent: "world-lens.live-observation.v1", pageContentIsUntrusted: true, actionsAuthorized: false }, maxBodyBytes: MAX_BODY, requiresApprovalToBrowse: true });
    if (req.method === "POST" && url.pathname === "/api/lens/live/start") {
      let input: any;
      try { input = await body(req); } catch { return json(res, 400, { error: "Invalid JSON or request body too large" }); }
      const interval = Number(input?.intervalSeconds);
      if (typeof input?.url !== "string") return json(res, 400, { error: "url is required" });
      if (!Number.isInteger(interval) || interval < 30 || interval > MAX_POLL_INTERVAL) return json(res, 400, { error: "intervalSeconds must be an integer from 30 to 3600" });
      try {
        const url = (await import("./world-lens.ts")).parseTargetUrl(input.url).toString();
        if (observers.has(url)) return json(res, 409, { error: "This URL already has a live observer" });
        if (observers.size >= MAX_LIVE_OBSERVERS) return json(res, 429, { error: "Live observer capacity reached" });
        const observer = new LiveObserver(async target => {
          let image: Buffer | undefined;
          const raw = await observeUrl(target, async (_id, png) => { image = png; return ""; });
          if (!image) throw new Error("Screenshot was not captured");
          const screenshot = await storeScreenshot(raw.id, image);
          const receipt = { ...raw, screenshotUrl: screenshot.url, screenshotHash: screenshot.sha256 };
          await storeReceipt(receipt);
          return receipt as ObservationReceiptLike;
        }, async () => {}, async event => { await storeObservationEvent(event); });
        observers.set(url, observer);
        const state = await observer.start(url, interval);
        return json(res, 201, state);
      } catch (error) { return json(res, 422, { error: error instanceof Error ? error.message : "Live observation failed" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/lens/live/stop") {
      let input: any;
      try { input = await body(req); } catch { return json(res, 400, { error: "Invalid JSON or request body too large" }); }
      if (typeof input?.url !== "string") return json(res, 400, { error: "url is required" });
      try {
        const url = (await import("./world-lens.ts")).parseTargetUrl(input.url).toString();
        const observer = observers.get(url);
        if (!observer) return json(res, 404, { error: "No active observer for URL" });
        observer.stop(); observers.delete(url);
        return json(res, 200, { stopped: true, url });
      } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid URL" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/lens/live/state") return json(res, 200, { observers: [...observers.values()].map(o => o.getState()) });
    if (req.method === "GET" && url.pathname === "/api/lens/live/events") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? 30);
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 30;
      return json(res, 200, { events: await readObservationEvents(limit) });
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
    // the same capture as an evidence pack (lib/evidence.js): items with captured positions, the screenshot by hash
    const packMatch = url.pathname.match(/^\/api\/lens\/receipts\/([0-9a-f-]{36})\/pack$/i);
    if (req.method === "GET" && packMatch) {
      const receipt = await readReceipt(packMatch[1]) as (Awaited<ReturnType<typeof readReceipt>> & { screenshotHash?: string }) | null;
      if (!receipt?.screenshotHash) return json(res, 404, { error: "Receipt not found" });
      return json(res, 200, await packFromReceipt(receipt, { screenshotFile: `${receipt.id}.png`, screenshotSha256: receipt.screenshotHash }));
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
  const stop=()=>{void shutdown().catch(error=>{console.error(error);process.exitCode=1})};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
}
