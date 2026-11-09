import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium, type Browser as PlaywrightBrowser } from "playwright";
import { extractVisibleBlocks, type TextBlock, type Viewport, type Box } from "../lib/extract-blocks.js";
export type { TextBlock, Viewport, Box };

export interface LinkEvidence { text: string; href: string; locator: string }
export interface ControlEvidence { role: string; label: string; type: string; locator: string; disabled: boolean }
export interface Observation { evidenceId: string; kind: "title" | "heading" | "text" | "link" | "control" | "block"; value: string; locator: string; box?: Box | null; inView?: boolean; drawn?: boolean }
export interface BrowserPort {
  navigate(url: string): Promise<{ requestedUrl: string; finalUrl: string; status: number | null; title: string }>;
  extractVisible(): Promise<{ title: string; text: string; headings: string[]; links: LinkEvidence[]; controls: ControlEvidence[]; blocks?: TextBlock[]; canvases?: Array<{ locator: string; box: Box }>; viewport?: Viewport }>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
export interface ObservationReceipt {
  id: string; sourceKind: "browser"; requestedUrl: string; finalUrl: string; status: number | null;
  title: string; text: string; headings: string[]; links: LinkEvidence[]; controls: ControlEvidence[];
  /** Paragraph-level text with positions on the screenshot (empty when the browser port can't measure them). */
  blocks: TextBlock[]; canvases: Array<{ locator: string; box: Box }>; viewport: Viewport | null;
  observations: Observation[]; snapshotHash: string; screenshotUrl: string; engine: string;
  actionsPerformed: string[]; mutations: [];
}

const MAX_TEXT = 12_000, MAX_LINKS = 50, MAX_CONTROLS = 60, MAX_REDIRECTS = 8, MAX_BLOCKS = 200, MAX_BLOCK_CHARS = 2_000;
export function parseTargetUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("URL must be a string no longer than 2048 characters");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Provide a valid absolute HTTPS URL"); }
  if (url.protocol !== "https:") throw new Error("Only HTTPS pages are allowed");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  if (url.search) throw new Error("URLs containing query parameters are not allowed in this first slice");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isIP(hostname)) throw new Error("Local, private, and literal-IP targets are not allowed");
  url.hash = ""; return url;
}
const blockedNetworks: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];
const blocked6: Array<[string, number]> = [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["2001:db8::", 32], ["ff00::", 8], ["::ffff:0:0", 96]];
function ipv4Number(ip: string): number { return ip.split(".").reduce((v, octet) => (v * 256 + Number(octet)) >>> 0, 0); }
function inV4Subnet(ip: string, base: string, bits: number): boolean { const shift = 32 - bits; return bits === 0 || (ipv4Number(ip) >>> shift) === (ipv4Number(base) >>> shift); }
export async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || isIP(normalized) || (normalized.startsWith("[") && normalized.endsWith("]") && isIP(normalized.slice(1, -1)))) throw new Error("Navigation blocked: private or literal-IP host");
  let records: Array<{ address: string; family: number }>;
  try { records = await lookup(normalized, { all: true, verbatim: true }); } catch { throw new Error("Navigation blocked: hostname did not resolve"); }
  if (!records.length || records.some(({ address, family }) => {
    if (family === 4) return blockedNetworks.some(([base, bits]) => inV4Subnet(address, base, bits));
    if (family === 6) return blocked6.some(([base, bits]) => {
      if (bits === 128) return address === base;
      const prefix = base.split(":").filter(Boolean)[0]; return prefix ? address.toLowerCase().startsWith(prefix.toLowerCase()) : false;
    });
    return true;
  })) throw new Error("Navigation blocked: DNS resolved to a non-public or unsupported address");
}
function cleanText(value: unknown, max = 500): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

export class PlaywrightBrowserPort implements BrowserPort {
  private browser: PlaywrightBrowser | null = null;
  private page: import("playwright").Page | null = null;
  private readonly seenUrls = new Set<string>();
  private redirects = 0;
  static async create(): Promise<PlaywrightBrowserPort> {
    const port = new PlaywrightBrowserPort();
    port.browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check", "--no-first-run"] });
    const context = await port.browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true, ignoreHTTPSErrors: false });
    await context.route("**/*", async route => {
      const request = route.request(), requestUrl = new URL(request.url());
      if (requestUrl.protocol !== "https:" || !["GET", "HEAD"].includes(request.method()) || requestUrl.username || requestUrl.password) return route.abort("blockedbyclient");
      if (!port.seenUrls.has(requestUrl.href)) {
        port.redirects++; if (port.redirects > MAX_REDIRECTS) return route.abort("blockedbyclient");
        try { await assertPublicHost(requestUrl.hostname); } catch { return route.abort("blockedbyclient"); }
        port.seenUrls.add(requestUrl.href);
      }
      await route.continue();
    });
    port.page = await context.newPage(); port.page.setDefaultNavigationTimeout(15_000); port.page.setDefaultTimeout(5_000); return port;
  }
  async navigate(rawUrl: string) {
    if (!this.page) throw new Error("Browser is closed");
    const url = parseTargetUrl(rawUrl); await assertPublicHost(url.hostname); this.seenUrls.clear(); this.redirects = 0;
    const response = await this.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    await this.page.waitForTimeout(500); const finalUrl = parseTargetUrl(this.page.url()); await assertPublicHost(finalUrl.hostname);
    return { requestedUrl: url.toString(), finalUrl: finalUrl.toString(), status: response?.status() ?? null, title: cleanText(await this.page.title(), 300) };
  }
  async currentLocation(): Promise<string> {
    if (!this.page) throw new Error("Browser is closed");
    return this.page.url();
  }
  async extractVisible() {
    if (!this.page) throw new Error("Browser is closed");
    const extracted = await this.page.evaluate(({ maxText, maxLinks, maxControls }) => {
      const body = document.body;
      const text = (body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxText);
      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0; })
        .map(el => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 30);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter(el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0; })
        .slice(0, maxLinks)
        .map((el, i) => ({ text: (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 200), href: (el as HTMLAnchorElement).href, locator: el.id ? `#${el.id}` : `a[href]:nth-of-type(${i + 1})` }))
        .filter(item => item.text && item.href);
      const controls = Array.from(document.querySelectorAll("button,input,select,textarea,[role=button],[role=link]"))
        .filter(el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0; })
        .slice(0, maxControls)
        .map((el, i) => ({ role: el.getAttribute("role") || (el.tagName === "INPUT" ? (el.getAttribute("type") || "text") : el.tagName.toLowerCase()), label: (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 300), type: el.getAttribute("type") || el.tagName.toLowerCase(), locator: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`, disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" }))
        .filter(item => item.label);
      return { title: document.title.slice(0, 300), text, headings, links, controls };
    }, { maxText: MAX_TEXT, maxLinks: MAX_LINKS, maxControls: MAX_CONTROLS });
    const measured = await this.page.evaluate(extractVisibleBlocks, { maxBlocks: MAX_BLOCKS, maxChars: MAX_BLOCK_CHARS }) as ReturnType<typeof extractVisibleBlocks>;
    return { ...extracted, blocks: measured.blocks, canvases: measured.canvases, viewport: measured.viewport };
  }
  async screenshot(): Promise<Buffer> { if (!this.page) throw new Error("Browser is closed"); return Buffer.from(await this.page.screenshot({ type: "png", fullPage: false, animations: "disabled" })); }
  async close() { await this.browser?.close(); this.browser = null; this.page = null; }
}

export async function observeHtml(browser: BrowserPort, rawUrl: string, saveScreenshot?: (id: string, png: Buffer) => Promise<string>): Promise<ObservationReceipt> {
  const requested = parseTargetUrl(rawUrl).toString();
  try {
    const navigated = await browser.navigate(requested), page = await browser.extractVisible(), screenshot = await browser.screenshot(), id = randomUUID();
    const observations: Observation[] = [];
    const add = (kind: Observation["kind"], value: string, locator: string, at?: Pick<Observation, "box" | "inView" | "drawn">) => observations.push({ evidenceId: `E${String(observations.length + 1).padStart(3, "0")}`, kind, value, locator, ...at });
    const blocks = page.blocks ?? [], canvases = page.canvases ?? [], viewport = page.viewport ?? null;
    add("title", page.title, "document.title"); page.headings.forEach((x, i) => add("heading", x, `heading[${i + 1}]`));
    if (page.text) add("text", page.text, "document.body.innerText");
    page.links.forEach(x => add("link", `${x.text} → ${x.href}`, x.locator)); page.controls.forEach(x => add("control", `${x.role}: ${x.label}${x.disabled ? " (disabled)" : ""}`, x.locator));
    blocks.forEach(x => add("block", x.text, x.locator, { box: x.box, inView: x.inView, drawn: x.drawn }));
    const snapshot = JSON.stringify({ title: page.title, text: page.text, headings: page.headings, links: page.links, controls: page.controls, blocks, canvases, viewport, observations });
    const screenshotUrl = saveScreenshot ? await saveScreenshot(id, screenshot) : `data:image/png;base64,${screenshot.toString("base64")}`;
    return { id, sourceKind: "browser", requestedUrl: navigated.requestedUrl, finalUrl: navigated.finalUrl, status: navigated.status, title: page.title, text: page.text, headings: page.headings, links: page.links, controls: page.controls, blocks, canvases, viewport, observations, snapshotHash: createHash("sha256").update(snapshot).digest("hex"), screenshotUrl, engine: "chromium", actionsPerformed: ["navigate", "extract_visible_dom", "screenshot"], mutations: [] };
  } finally { await browser.close(); }
}
export async function observeUrl(rawUrl: string, saveScreenshot?: (id: string, png: Buffer) => Promise<string>) { return observeHtml(await PlaywrightBrowserPort.create(), rawUrl, saveScreenshot); }
