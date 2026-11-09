import assert from "node:assert/strict";
import { test } from "node:test";
import { observeHtml, parseTargetUrl, type BrowserPort } from "../src/world-lens.ts";

const fixture = `<!doctype html><html><head><title>Test studio</title><style>.hidden{display:none}</style><script>const privateState="not visible"</script></head><body>
<header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
<main><h1>Build your profile</h1><p>This page is visible fixture content for the observer.</p><form action="/submit"><label for="topic">Project topic</label><input id="topic" name="topic"><button type="submit">Save draft</button></form><a href="/details">Read details</a><div class="hidden">hidden content</div></main>
<footer>Footer noise</footer></body></html>`;

function fixtureBrowser(html = fixture, finalUrl = "https://example.com/fixture") : BrowserPort {
  return {
    async navigate(url: string) { return { requestedUrl: url, finalUrl: "https://example.com/fixture", status: 200, title: "ignored" }; },
    async extractVisible() { return { title: "Test studio", text: "Build your profile\nThis page is visible fixture content for the observer.\nProject topic\nSave draft\nRead details", headings: ["Build your profile"], links: [{ text: "Home", href: "https://example.com/", locator: "nav a:nth-of-type(1)" }, { text: "About", href: "https://example.com/about", locator: "nav a:nth-of-type(2)" }, { text: "Read details", href: "https://example.com/details", locator: "main a#details" }], controls: [{ role: "textbox", label: "Project topic", type: "text", locator: "#topic", disabled: false }, { role: "button", label: "Save draft", type: "submit", locator: "button", disabled: false }] }; },
    async screenshot() { return Buffer.from("fixture-png-bytes"); },
    async close() {}
  };
}

test("URL policy allows only public-looking HTTP(S) pages and rejects local/private targets", () => {
  assert.equal(parseTargetUrl("https://example.com/path#section").toString(), "https://example.com/path");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/", "https://example.com/?secret=1"]) {
    assert.throws(() => parseTargetUrl(url), /HTTPS|credentials|query/);
  }
});

test("public hostname guard rejects local, private and link-local targets", async () => {
  const { assertPublicHost } = await import("../src/world-lens.ts");
  for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "10.0.0.2", "169.254.169.254", "[::1]"]) {
    await assert.rejects(() => assertPublicHost(host), /private|literal-IP|non-public/);
  }
});

test("browser observation returns source-linked compact evidence and performs no mutations", async () => {
  let closed = false;
  let screenshotCalls = 0;
  const browser = fixtureBrowser();
  browser.close = async () => { closed = true; };
  browser.screenshot = async () => { screenshotCalls++; return Buffer.from("fixture-png-bytes"); };
  const receipt = await observeHtml(browser, "https://example.com/fixture");
  assert.equal(receipt.sourceKind, "browser");
  assert.equal(receipt.title, "Test studio");
  assert.deepEqual(receipt.headings, ["Build your profile"]);
  assert.equal(receipt.links.some(x => x.text === "Read details"), true);
  assert.equal(receipt.controls.some(x => x.label === "Save draft"), true);
  assert.equal(receipt.observations.every(x => Boolean(x.evidenceId && x.locator)), true);
  assert.deepEqual(receipt.actionsPerformed, ["navigate", "extract_visible_dom", "screenshot"]);
  assert.deepEqual(receipt.mutations, []);
  assert.equal(screenshotCalls, 1);
  assert.equal(closed, true);
});

test("observer closes browser if extraction fails and provides no action interface", async () => {
  let closed = false;
  const browser = fixtureBrowser();
  browser.extractVisible = async () => { throw new Error("fixture extraction failure"); };
  browser.close = async () => { closed = true; };
  await assert.rejects(() => observeHtml(browser, "https://example.com/fixture"), /fixture extraction failure/);
  assert.equal(closed, true);
});
