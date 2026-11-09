#!/usr/bin/env node
// Verify an evidence pack, and optionally that a list of quotes is supported by it.
//
//   node bin/lens-verify.mjs pack.json [--dir <folder>]... [--quotes quotes.json] [--allow-missing-screens] [--json]
//
// --dir may repeat: files are looked up in each folder in turn (originals and displayed copies often live apart).
// Without --dir, files are looked up next to the pack.
//
// quotes.json: [{ "text": "...", "cite": "P3.A1" }, { "text": "..." }]. With cite, the item must contain the text;
// without, some item must. Exit status 0 only if the pack verifies and every quote is supported.
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { verifyPack, supports, findSupport } from "../lib/evidence.js";
const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const packFile = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir" && args[i - 1] !== "--quotes");
if (!packFile) { console.error("usage: lens-verify <pack.json> [--dir <folder>] [--quotes <quotes.json>] [--json]"); process.exit(2); }
const pack = JSON.parse(await readFile(packFile, "utf8"));
const dirs = args.flatMap((a, i) => args[i - 1] === "--dir" ? [resolve(a)] : []);
if (!dirs.length) dirs.push(resolve(dirname(packFile)));
const read = async file => { for (const dir of dirs) { try { return new Uint8Array(await readFile(join(dir, file))); } catch {} } return null; };
const result = await verifyPack(pack, { read, allowMissingScreens: args.includes("--allow-missing-screens") });
const quotes = opt("--quotes") ? JSON.parse(await readFile(opt("--quotes"), "utf8")) : [];
const unsupported = [];
for (const q of quotes) {
  const reason = q.cite || q.illustrative ? supports(pack, q.cite, q.text, { illustrative: !!q.illustrative }) : (findSupport(pack, q.text) ? null : "not in any evidence item");
  if (reason) unsupported.push({ text: q.text, cite: q.cite || null, reason });
}
const ok = result.ok && unsupported.length === 0;
if (args.includes("--json")) console.log(JSON.stringify({ ok, ...result, quotes: quotes.length, unsupported }, null, 1));
else {
  console.log(`${ok ? "ok" : "FAILED"}: ${result.checked.items} items, ${result.checked.screens} screens and ${result.checked.derivatives} derivatives verified; snapshot ${String(pack.snapshotHash).slice(0, 12)}; ${quotes.length - unsupported.length}/${quotes.length} quotes supported`);
  for (const e of result.errors) console.log("  error: " + e);
  for (const w of result.warnings.slice(0, 3)) console.log("  note: " + w);
  if (result.warnings.length > 3) console.log(`  note: … and ${result.warnings.length - 3} more like these`);
  for (const u of unsupported) console.log(`  unsupported: "${u.text}" — ${u.reason}`);
}
process.exit(ok ? 0 : 1);
