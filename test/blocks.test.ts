import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractVisibleBlocks } from "../lib/extract-blocks.js";

const fixture = `<!doctype html><html><head><title>Blocks</title><style>
body{margin:0;font:16px/1.4 sans-serif} main{width:600px;margin:40px 0 0 100px} .ghost{opacity:0} .far{margin-top:2000px}
</style></head><body><main>
<h1 id="title">A guest book</h1>
<p id="answer">The notebook doesn’t hold an answer to that. It only knows <a href="/x">a handful of essays</a>, and none of them speaks to this question.</p>
<ul><li>First item</li><li>Second <em>item</em></li></ul>
<p hidden>HIDDEN CANARY</p><p class="ghost">GHOST CANARY</p><input value="INPUT CANARY"><script>void "SCRIPT CANARY"</script>
<p class="far" id="below">Below the fold.</p>
</main></body></html>`;

test("visible text comes back as paragraph-level blocks with boxes that match the elements", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(fixture);
    const before = await page.content();
    const { viewport, blocks } = await page.evaluate(extractVisibleBlocks, { maxBlocks: 50 });
    assert.deepEqual(viewport, { width: 1000, height: 800, deviceScaleFactor: 1 });
    assert.deepEqual(blocks.map(b => b.text), ["A guest book", "The notebook doesn’t hold an answer to that. It only knows a handful of essays, and none of them speaks to this question.", "First item", "Second item", "Below the fold."].map(t => t.replace(/\s+/g, " ")));
    assert.equal(blocks.every(b => !/CANARY/.test(b.text)), true);
    assert.equal(blocks[0].kind, "heading"); assert.equal(blocks[1].kind, "text");
    // the link folds into its paragraph, and the box is the paragraph's text, in viewport fractions
    const answer = blocks[1], rect = await page.locator("#answer").boundingBox();
    assert.ok(rect); assert.ok(answer.box);
    assert.ok(Math.abs(answer.box[0] * 1000 - rect.x) < 2 && Math.abs(answer.box[1] * 800 - rect.y) < 4, JSON.stringify([answer.box, rect]));
    assert.ok(answer.box[2] * 1000 <= rect.width + 1 && answer.box[3] * 800 <= rect.height + 1);
    assert.equal(answer.locator, "#answer");
    assert.equal(answer.inView, true);
    const below = blocks.find(b => b.text === "Below the fold.");
    assert.ok(below?.box); assert.equal(below.inView, false); assert.ok(below.box[1] > 1);
    assert.equal(await page.content(), before, "extraction must not change the document");
  } finally { await browser.close(); }
});

test("blocks are capped and long text is bounded", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<body>${Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i} ${"word ".repeat(400)}</p>`).join("")}</body>`);
    const { blocks } = await page.evaluate(extractVisibleBlocks, { maxBlocks: 10, maxChars: 120 });
    assert.equal(blocks.length, 10);
    assert.equal(blocks.every(b => b.text.length <= 120), true);
  } finally { await browser.close(); }
});

test("text kept only for screen readers is reported as not drawn, with no position; canvases are listed", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(`<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
      <div class="answer"><canvas width="400" height="120" style="width:400px;height:120px"></canvas><p class="sr-only">The answer, painted on the canvas above.</p></div><p>Read the originals.</p>`);
    const { blocks, canvases } = await page.evaluate(extractVisibleBlocks, {});
    const sr = blocks.find(b => b.text.startsWith("The answer"));
    assert.ok(sr); assert.equal(sr.drawn, false); assert.equal(sr.box, null); assert.equal(sr.inView, false);
    assert.equal(blocks.find(b => b.text === "Read the originals.")?.drawn, true);
    assert.equal(canvases.length, 1); assert.deepEqual(canvases[0].box.map(v => Math.round(v * 1000)), [8, 10, 400, 150]);
  } finally { await browser.close(); }
});
