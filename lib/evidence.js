// Evidence packs: what a lens saw, in a form anything can check before it shows or says something about it.
//
// No dependencies and no Node APIs (hashing uses Web Crypto), so the same file runs in Node, in a browser page,
// and, built as dist/evidence.iife.js, inside pages that don't load modules. bin/lens-verify.mjs is the CLI.
//
// A pack has:
//   source       where it came from: { kind: "browser" | "file" | "api", url | file, … } plus anything that
//                happened to produce it (e.g. visits that changed the site), stated rather than implied.
//   screens      images of what was seen: { id, file, sha256, width, height }.
//   items        evidence: { id, text, kind?, locator?, at: [{ screen, box: [x, y, w, h], by }] }.
//                Boxes are fractions of the screen. by: "capture" for positions measured when the screen was
//                taken; by: "editor" for positions someone placed by hand afterwards (where to look, not evidence).
//   derivatives  copies of screens made for display (resized, recompressed): { of, file, sha256, note }.
//   snapshotHash sha256 of the canonical form: schema, source, every item's id, text and captured positions, and
//                every screen's hash. Editor positions and derivatives are checked separately, not hashed in,
//                so placing a zoom box or re-exporting a thumbnail doesn't change what was captured.
//   The boundary: pageContentIsUntrusted: true, actionAuthorized: false, mutations: [], interpretation: null.
//
// The one rule consumers share: a quote is shown or said only if the item it cites contains it, or if it is
// marked as illustration. supports() gives the refusal reasons as stable strings.

export const PACK_SCHEMA = "world-lens.evidence-pack.v1";

const canonicalJson = value => {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  return JSON.stringify(value === undefined ? null : value);
};

/** The exact string the snapshot hash is computed over. */
export function canonicalPack(pack) {
  return canonicalJson([
    pack.schema, pack.source || null,
    (pack.items || []).map(i => [i.id, i.text, (i.at || []).filter(a => a.by === "capture").map(a => [a.screen, a.box])]),
    (pack.screens || []).map(s => [s.id, s.sha256]),
  ]);
}

/** SHA-256 hex of a string or bytes, via Web Crypto (Node 20+, browsers). */
export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPack(pack) { return sha256Hex(canonicalPack(pack)); }

/** Fill in snapshotHash and the boundary fields. */
export async function sealPack(pack) {
  const sealed = { schema: PACK_SCHEMA, derivatives: [], ...pack, pageContentIsUntrusted: true, actionAuthorized: false, mutations: [], interpretation: null };
  sealed.snapshotHash = await hashPack(sealed);
  return sealed;
}

const isBox = b => Array.isArray(b) && b.length === 4 && b.every(v => typeof v === "number" && Number.isFinite(v)) && b[2] >= 0 && b[3] >= 0;

/**
 * Check a pack. With read(file) → bytes (or null), also re-hash every screen and derivative.
 * allowMissingScreens: an original screen that isn't present is a warning, not an error, provided a derivative
 * of it is present and verifies (originals are often kept elsewhere; the copies shown travel with the work).
 * Returns { ok, errors, warnings, checked: { items, screens, derivatives } }.
 */
export async function verifyPack(pack, { read, allowMissingScreens = false } = {}) {
  const errors = [], warnings = [];
  if (!pack || pack.schema !== PACK_SCHEMA) errors.push(`schema is not ${PACK_SCHEMA}`);
  if (pack.pageContentIsUntrusted !== true || pack.actionAuthorized !== false || !Array.isArray(pack.mutations) || pack.mutations.length || pack.interpretation !== null)
    errors.push("boundary fields are missing or altered (pageContentIsUntrusted, actionAuthorized, mutations, interpretation)");
  const screens = new Map((pack.screens || []).map(s => [s.id, s]));
  if (screens.size !== (pack.screens || []).length) errors.push("screen ids are not unique");
  const ids = new Set();
  for (const item of pack.items || []) {
    if (!item.id || typeof item.text !== "string") { errors.push(`item ${item.id || "?"} has no id or text`); continue; }
    if (ids.has(item.id)) errors.push(`item id ${item.id} is not unique`); ids.add(item.id);
    for (const a of item.at || []) {
      if (!screens.has(a.screen)) errors.push(`item ${item.id} is placed on unknown screen ${a.screen}`);
      if (!isBox(a.box)) errors.push(`item ${item.id} has a malformed box on ${a.screen}`);
      if (a.by !== "capture" && a.by !== "editor") errors.push(`item ${item.id} position on ${a.screen} must say by: "capture" or "editor"`);
    }
  }
  if ((await hashPack(pack)) !== pack.snapshotHash) errors.push("snapshotHash does not match the pack's contents");
  let screensChecked = 0, derivativesChecked = 0;
  for (const d of pack.derivatives || []) if (!screens.has(d.of)) errors.push(`derivative ${d.file} is of unknown screen ${d.of}`);
  if (read) {
    const verifiedCopies = new Set();
    for (const d of pack.derivatives || []) {
      const bytes = await read(d.file);
      if (!bytes) errors.push(`derivative ${d.file} is missing`);
      else if ((await sha256Hex(bytes)) !== d.sha256) errors.push(`derivative ${d.file} changed since it was recorded`);
      else { derivativesChecked++; verifiedCopies.add(d.of); }
    }
    for (const s of pack.screens || []) {
      const bytes = await read(s.file);
      if (!bytes) {
        if (allowMissingScreens && verifiedCopies.has(s.id)) warnings.push(`screen ${s.id}: original ${s.file} not present; its displayed copy verified`);
        else errors.push(`screen ${s.id}: ${s.file} is missing`);
      }
      else if ((await sha256Hex(bytes)) !== s.sha256) errors.push(`screen ${s.id}: ${s.file} changed since capture`);
      else screensChecked++;
    }
  }
  return { ok: errors.length === 0, errors, warnings, checked: { items: ids.size, screens: screensChecked, derivatives: derivativesChecked } };
}

/** An item by id, with its position on a given screen (or its first position). null if there is no such item. */
export function evidenceIn(pack, id, screen) {
  const item = (pack.items || []).find(i => i.id === id);
  if (!item) return null;
  const at = (item.at || []).find(a => screen == null || a.screen === screen) || null;
  return { id: item.id, text: item.text, kind: item.kind, screen: at ? at.screen : null, box: at ? at.box : null, by: at ? at.by : null };
}

/** Quote comparison: case, quote marks and apostrophes, and whitespace don't count; words and punctuation do. */
export function normalizeQuote(s) {
  return String(s).toLowerCase().replace(/[“”"]/g, "").replace(/[’‘']/g, "'").replace(/\s+/g, " ").trim();
}
const contains = (text, quote) => {
  const t = normalizeQuote(text), q = normalizeQuote(quote);
  return t.includes(q) || t.replace(/ /g, "").includes(q.replace(/ /g, ""));
};

/**
 * The shared rule. Returns null when the quote may be shown, otherwise the reason it may not:
 *   "uncited and not marked illustrative" · "no such evidence: <id>" · "not in the evidence (<id>)"
 */
export function supports(pack, cite, quote, { illustrative = false } = {}) {
  if (illustrative) return null;
  if (!cite) return "uncited and not marked illustrative";
  const item = evidenceIn(pack, cite);
  if (!item) return "no such evidence: " + cite;
  if (quote != null && quote !== "" && !contains(item.text, quote)) return "not in the evidence (" + cite + ")";
  return null;
}

/** The first item that contains the quote, for text that is read aloud without naming its source. */
export function findSupport(pack, quote) {
  const item = (pack.items || []).find(i => contains(i.text, quote));
  return item ? item.id : null;
}

/**
 * A pack from a World Lens browser receipt (src/world-lens.ts). Every observation becomes an item with its
 * receipt evidence id; paragraph blocks that were drawn on screen carry their captured position on the screenshot.
 */
export async function packFromReceipt(receipt, { screenshotFile = "screenshot.png", screenshotSha256 = receipt.screenshotHash } = {}) {
  if (!screenshotSha256) throw new Error("the receipt has no screenshot hash; pass screenshotSha256");
  const vp = receipt.viewport || { width: 0, height: 0, deviceScaleFactor: 1 };
  const screen = { id: "viewport", file: screenshotFile, sha256: screenshotSha256, width: Math.round(vp.width * vp.deviceScaleFactor), height: Math.round(vp.height * vp.deviceScaleFactor) };
  return sealPack({
    source: { kind: "browser", url: receipt.finalUrl, requestedUrl: receipt.requestedUrl, status: receipt.status, receiptId: receipt.id, receiptSnapshotHash: receipt.snapshotHash, actionsPerformed: receipt.actionsPerformed || [] },
    screens: [screen],
    items: (receipt.observations || []).map(o => ({ id: o.evidenceId, text: o.value, kind: o.kind, locator: o.locator,
      at: o.box && o.drawn !== false ? [{ screen: "viewport", box: o.box, by: "capture" }] : [] })),
  });
}
