import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObservationReceipt } from "./world-lens.ts";
import type { ObservationChange } from "./live-observation.ts";

const DATA = process.env.DATA_DIR || join(process.cwd(), "data");
const RECEIPTS = join(DATA, "receipts");
const SHOTS = join(DATA, "screenshots");
const OBSERVATIONS = join(DATA, "observations");
const observationFile = (id: string) => join(OBSERVATIONS, `${id}.json`);
const receiptFile = (id: string) => join(RECEIPTS, `${id}.json`);
const validId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function storeScreenshot(id: string, screenshot: Buffer) {
  if (!validId(id)) throw new Error("invalid receipt id");
  await mkdir(SHOTS, { recursive: true, mode: 0o700 });
  await writeFile(join(SHOTS, `${id}.png`), screenshot, { mode: 0o600, flag: "wx" });
  return { url: `/api/lens/receipts/${id}/screenshot`, sha256: createHash("sha256").update(screenshot).digest("hex") };
}
export async function storeReceipt(receipt: ObservationReceipt) {
  await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
  await writeFile(receiptFile(receipt.id), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
}
export async function storeObservationEvent(event: ObservationChange) {
  await mkdir(OBSERVATIONS, { recursive: true, mode: 0o700 });
  await writeFile(observationFile(event.sourceReceiptId), JSON.stringify(event, null, 2), { mode: 0o600, flag: "wx" });
}
export async function readObservationEvents(limit = 30): Promise<ObservationChange[]> {
  await mkdir(OBSERVATIONS, { recursive: true, mode: 0o700 });
  const names = (await readdir(OBSERVATIONS)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).sort().slice(-Math.max(1, Math.min(100, limit)));
  const events: ObservationChange[] = [];
  for (const name of names) { try { events.push(JSON.parse(await readFile(join(OBSERVATIONS, name), "utf8"))); } catch {} }
  return events;
}
export async function readReceipt(id: string): Promise<ObservationReceipt | null> {
  if (!validId(id)) return null;
  try { return JSON.parse(await readFile(receiptFile(id), "utf8")); } catch { return null; }
}
export async function readScreenshot(id: string): Promise<Buffer | null> {
  if (!validId(id)) return null;
  try { return await readFile(join(SHOTS, `${id}.png`)); } catch { return null; }
}
