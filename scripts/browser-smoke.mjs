import assert from "node:assert/strict";
import { chromium } from "playwright";

const port = Number(process.env.SMOKE_PORT || 8792);
const base = `http://127.0.0.1:${port}`;
const probe = await fetch(`${base}/healthz`);
const health = await probe.json().catch(() => ({}));
assert.equal(health.service, "world-lens", `No World Lens API on ${base}`);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  const uiTitle = await page.title();
  assert.equal(uiTitle, "World Lens · external-page observer");
  await page.locator("#url").fill("https://example.org/");
  await page.getByRole("button", { name: /Observe page/ }).click();
  await Promise.race([
    page.locator("#report:not([hidden])").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator("#error:not([hidden])").waitFor({ state: "visible", timeout: 30_000 }).then(async () => { throw new Error(`Observe request failed: ${await page.locator("#error").innerText()}`); })
  ]);
  const renderedHeading = await page.locator("#page-title").innerText();
  const textContent = await page.locator("#visible-text").innerText();
  const imageLoaded = await page.locator("#screenshot").evaluate(img => img.complete && img.naturalWidth > 0);
  assert.match(renderedHeading, /Example Domain/i);
  assert.match(textContent, /documentation examples/i);
  assert.equal(imageLoaded, true, "the receipt screenshot should load in the UI");
  const receiptId = await page.locator("#receipt-id").getAttribute("data-receipt-id");
  const receipt = await page.request.get(`${base}/api/lens/receipts/${receiptId}`);
  const readbackBody = await receipt.text();
  assert.equal(receipt.status(), 200, `receipt ${receiptId}: ${readbackBody}`);
  const saved = JSON.parse(readbackBody);
  assert.deepEqual(saved.mutations, []);
  assert.deepEqual(saved.actionsPerformed, ["navigate", "extract_visible_dom", "screenshot"]);
  assert.equal(saved.requestedUrl, "https://example.org/");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "PASS", uiTitle, requestedUrl: saved.requestedUrl, finalUrl: saved.finalUrl, screenshotLoaded: imageLoaded, renderedHeading, textExcerpt: textContent.slice(0, 120), receiptId, mutations: saved.mutations, errors }, null, 2));
} finally { await browser?.close(); }
