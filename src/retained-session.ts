import { randomUUID } from "node:crypto";
import { observeHtml, parseTargetUrl, type BrowserPort } from "./world-lens.ts";

type RetainedPort = BrowserPort & { currentLocation(): Promise<string> };
export class RetainedBrowserSession {
 readonly id = randomUUID();
 private closed = false;
 private busy = false;
 private constructor(private browser: RetainedPort, readonly url: string, private navigation: Awaited<ReturnType<BrowserPort["navigate"]>>) {}
 static async open(browser: RetainedPort, rawUrl: string) {
  try {
   const url = parseTargetUrl(rawUrl).toString();
   const navigation = await browser.navigate(url);
   if (navigation.finalUrl !== url) throw new Error("Retained tab navigation changed the approved URL");
   return new RetainedBrowserSession(browser, url, navigation);
  } catch(error) { await browser.close(); throw error; }
 }
 async capture(saveScreenshot?: (id: string, png: Buffer) => Promise<string>) {
  if(this.closed) throw new Error("Retained session is closed");
  if(this.busy) throw new Error("Retained capture already in progress");
  this.busy = true;
  try {
   if(await this.browser.currentLocation() !== this.url) throw new Error("Retained tab navigation changed; approval required");
   // Reuse the production receipt/extraction implementation, without navigating or closing the retained tab.
   const receipt = await observeHtml({
    navigate: async () => this.navigation,
    extractVisible: () => this.browser.extractVisible(),
    screenshot: () => this.browser.screenshot(),
    close: async () => {},
   }, this.url, saveScreenshot);
   if(this.closed || await this.browser.currentLocation() !== this.url) throw new Error("Retained session closed or navigation changed during capture");
   return { ...receipt, sessionId: this.id, captureMode: "retained-tab" as const, actionsPerformed: ["extract_visible_dom", "screenshot"] };
  } finally { this.busy = false; }
 }
 async close() { if(!this.closed) { this.closed = true; await this.browser.close(); } }
}
