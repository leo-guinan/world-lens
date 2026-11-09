import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { sealPack, verifyPack, supports, findSupport, evidenceIn, packFromReceipt, hashPack, PACK_SCHEMA, type EvidencePack } from "../lib/evidence.js";
import { observeHtml, type BrowserPort } from "../src/world-lens.ts";
import { extractVisibleBlocks } from "../lib/extract-blocks.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const png = Buffer.from("not really a png, but bytes all the same");

async function samplePack(): Promise<EvidencePack> {
  return sealPack({
    source: { kind: "api", url: "https://enchantednotebook.com/api/pages" },
    screens: [{ id: "A-2-answered", file: "A-2-answered.png", sha256: sha(png), width: 2560, height: 1600 }],
    items: [
      { id: "P4.A2", text: "From “Power to the Person”: Packy argues that software, crypto and NFTs are shifting power from companies to individuals.", at: [{ screen: "A-2-answered", box: [0.53, 0.355, 0.38, 0.29], by: "editor" }] },
      { id: "P4.A2x", text: "In his words: \"Creators, even well-paid ones, are still more labor than capital.\"", at: [] },
    ],
  });
}

test("a sealed pack verifies, and every screen is re-hashed when files are available", async () => {
  const pack = await samplePack();
  assert.equal(pack.schema, PACK_SCHEMA);
  assert.deepEqual([pack.pageContentIsUntrusted, pack.actionAuthorized, pack.mutations, pack.interpretation], [true, false, [], null]);
  const r = await verifyPack(pack, { read: async f => f === "A-2-answered.png" ? new Uint8Array(png) : null });
  assert.deepEqual(r, { ok: true, errors: [], warnings: [], checked: { items: 2, screens: 1, derivatives: 0 } });
});

test("changed text, a changed screen, an altered boundary and a missing derivative are all caught", async () => {
  const pack = await samplePack();
  const edited = structuredClone(pack); edited.items[0].text = edited.items[0].text.replace("individuals", "institutions");
  assert.match((await verifyPack(edited)).errors.join(), /snapshotHash does not match/);
  const swapped = await verifyPack(pack, { read: async () => new Uint8Array(Buffer.from("other bytes")) });
  assert.match(swapped.errors.join(), /changed since capture/);
  const loosened = { ...pack, actionAuthorized: true } as unknown as EvidencePack;
  assert.match((await verifyPack(loosened)).errors.join(), /boundary/);
  const withCopy = { ...pack, derivatives: [{ of: "A-2-answered", file: "A-2-answered.jpg", sha256: sha("jpeg bytes") }] };
  assert.match((await verifyPack(withCopy, { read: async f => f.endsWith(".png") ? new Uint8Array(png) : null })).errors.join(), /derivative A-2-answered.jpg is missing/);
});

test("an original kept elsewhere is a warning only when its displayed copy verifies", async () => {
  const pack = { ...(await samplePack()), derivatives: [{ of: "A-2-answered", file: "A-2-answered.jpg", sha256: sha("jpeg bytes"), note: "resized" }] };
  const onlyCopy = async (f: string) => f.endsWith(".jpg") ? new Uint8Array(Buffer.from("jpeg bytes")) : null;
  assert.match((await verifyPack(pack, { read: onlyCopy })).errors.join(), /A-2-answered.png is missing/);
  const r = await verifyPack(pack, { read: onlyCopy, allowMissingScreens: true });
  assert.equal(r.ok, true); assert.match(r.warnings.join(), /original A-2-answered.png not present; its displayed copy verified/);
  const neither = await verifyPack(pack, { read: async () => null, allowMissingScreens: true });
  assert.equal(neither.ok, false);
});

test("editor positions are checked but not hashed in; captured positions are", async () => {
  const pack = await samplePack();
  const moved = structuredClone(pack); moved.items[0].at![0].box = [0.5, 0.3, 0.4, 0.3];
  assert.equal(await hashPack(moved), pack.snapshotHash, "moving an editor's zoom box is not a change to the evidence");
  const captured = structuredClone(pack); captured.items[0].at![0].by = "capture";
  assert.notEqual(await hashPack(captured), pack.snapshotHash);
  const bad = structuredClone(pack); bad.items[0].at![0].screen = "nowhere";
  assert.match((await verifyPack(bad)).errors.join(), /unknown screen nowhere/);
});

test("the shared quote rule: cited and contained, or refused with a stable reason", async () => {
  const pack = await samplePack();
  assert.equal(supports(pack, "P4.A2", "Packy argues that software, crypto and NFTs are shifting power"), null);
  assert.equal(supports(pack, "P4.A2x", "Creators, even well-paid ones, are still more labor than capital."), null, "quote marks and case don't count");
  assert.equal(supports(pack, "P4.A2", "Creators should be paid in equity."), "not in the evidence (P4.A2)");
  assert.equal(supports(pack, "P9.A9", "anything"), "no such evidence: P9.A9");
  assert.equal(supports(pack, null, "an uncited claim"), "uncited and not marked illustrative");
  assert.equal(supports(pack, null, "a picture of stories vanishing", { illustrative: true }), null);
  assert.equal(findSupport(pack, "still more labor than capital"), "P4.A2x");
  assert.equal(findSupport(pack, "labor is capital"), null);
  assert.deepEqual(evidenceIn(pack, "P4.A2", "A-2-answered")?.box, [0.53, 0.355, 0.38, 0.29]);
});

test("a real capture becomes a pack whose paragraphs carry captured positions, and the CLI verifies it", async () => {
  const browser = await chromium.launch({ headless: true });
  let shot: Buffer = Buffer.alloc(0);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<title>Guest book</title><h1>Page 3</h1><p id="a">The notebook doesn’t hold an answer to that. It only knows <a href="/x">a handful of Packy’s essays</a>, and none of them speaks to this question.</p>`);
    const port: BrowserPort = {
      async navigate(url) { return { requestedUrl: url, finalUrl: url, status: 200, title: "Guest book" }; },
      async extractVisible() { const m = await page.evaluate(extractVisibleBlocks, {}); return { title: "Guest book", text: await page.innerText("body"), headings: ["Page 3"], links: [], controls: [], ...m }; },
      async screenshot() { shot = await page.screenshot(); return shot; },
      async close() {},
    };
    const receipt = await observeHtml(port, "https://example.com/guest-book");
    const pack = await packFromReceipt({ ...receipt, screenshotHash: sha(shot) }, { screenshotFile: "viewport.png" });
    const para = pack.items.find(i => i.kind === "block" && i.text.startsWith("The notebook"));
    assert.ok(para?.at?.length, "the paragraph is placed on the screenshot");
    assert.equal(para.at[0].by, "capture");
    const box = await page.locator("#a").boundingBox(); assert.ok(box);
    assert.ok(Math.abs(para.at[0].box[1] * 700 - box.y) < 4);
    assert.equal(supports(pack, para.id, "none of them speaks to this question"), null);

    const dir = mkdtempSync(join(tmpdir(), "lens-"));
    writeFileSync(join(dir, "pack.json"), JSON.stringify(pack)); writeFileSync(join(dir, "viewport.png"), shot);
    writeFileSync(join(dir, "quotes.json"), JSON.stringify([{ text: "It only knows a handful of Packy’s essays" }, { text: "none of them speaks to this question", cite: para.id }]));
    const out = execFileSync(process.execPath, ["bin/lens-verify.mjs", join(dir, "pack.json"), "--quotes", join(dir, "quotes.json")], { encoding: "utf8" });
    assert.match(out, /^ok: .* 1 screens .* 2\/2 quotes supported/);
    writeFileSync(join(dir, "quotes.json"), JSON.stringify([{ text: "It knows every essay ever written" }]));
    assert.throws(() => execFileSync(process.execPath, ["bin/lens-verify.mjs", join(dir, "pack.json"), "--quotes", join(dir, "quotes.json")], { encoding: "utf8" }),
      (e: { status: number; stdout: string }) => e.status === 1 && /unsupported: "It knows every essay ever written" — not in any evidence item/.test(e.stdout));
  } finally { await browser.close(); }
});

test("the page build exposes the same functions", async () => {
  execFileSync(process.execPath, ["scripts/build-evidence-iife.mjs"]);
  const g = globalThis as unknown as { WorldLensEvidence?: Record<string, unknown> };
  g.WorldLensEvidence = undefined;
  const { readFileSync } = await import("node:fs");
  new Function(readFileSync("dist/evidence.iife.js", "utf8"))();
  const api = (g.WorldLensEvidence ?? {}) as Record<string, unknown>;
  assert.equal(typeof api.supports, "function");
  assert.equal(typeof api.verifyPack, "function");
});
