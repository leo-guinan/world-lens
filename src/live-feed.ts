import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObservationChange } from "./live-observation.ts";
import { toSignal, type LensSignal } from "./signal.ts";

export interface FeedEntry { seq: number; at: string; signal: LensSignal; event: ObservationChange }

/** The ordered record of every change the live observers have seen. Each change gets the next sequence
 * number, is appended to one journal file, and is handed to whoever is listening. A consumer that was away
 * asks for everything after the last number it saw, so nothing is missed and nothing arrives twice. */
export class LiveFeed {
  seq = 0;
  private readonly recent: FeedEntry[] = [];
  private readonly listeners = new Set<(entry: FeedEntry) => void>();
  private writing: Promise<unknown> = Promise.resolve();
  /** The journal ends mid-line (a crash during a write): the next entry must start on a line of its own. */
  private torn = false;

  constructor(private readonly file: string | null, private readonly options: { keep?: number; rotateBytes?: number; legacyDir?: string } = {}) {}

  /** Read the journal back (after a restart). A torn last line, from a crash mid-write, is skipped. */
  async load(): Promise<this> {
    if (!this.file) return this;
    let text: string | null = null;
    try { text = await readFile(this.file, "utf8"); } catch { /* no journal yet */ }
    if (text === null) { await this.importLegacy(); return this; }
    this.torn = text.length > 0 && !text.endsWith("\n");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line) as FeedEntry; if (Number.isInteger(entry.seq) && entry.signal && entry.event) this.remember(entry); } catch { /* torn line */ }
    }
    return this;
  }

  /** Changes stored one file each by earlier versions become the start of the journal, oldest first. */
  private async importLegacy() {
    const dir = this.options.legacyDir; if (!dir) return;
    let names: string[] = []; try { names = (await readdir(dir)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)); } catch { return; }
    const events: ObservationChange[] = [];
    for (const name of names) { try { events.push(JSON.parse(await readFile(join(dir, name), "utf8"))); } catch { /* unreadable */ } }
    events.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
    for (const event of events) await this.append(event);
  }

  append(event: ObservationChange, context: { title?: string; screenshotUrl?: string | null } = {}): Promise<FeedEntry> {
    // one at a time, so sequence order, file order and delivery order are the same order
    const done = this.writing.then(async () => {
      const seq = this.seq + 1, entry: FeedEntry = { seq, at: event.observedAt, signal: toSignal(event, seq, context), event };
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        await this.rotateIfLarge();
        await appendFile(this.file, (this.torn ? "\n" : "") + JSON.stringify(entry) + "\n", { mode: 0o600 });
        this.torn = false;
      }
      this.remember(entry);
      for (const listener of this.listeners) { try { listener(entry); } catch { /* one bad listener must not stop the rest */ } }
      return entry;
    });
    this.writing = done.catch(() => {});
    return done;
  }

  private remember(entry: FeedEntry) {
    this.seq = Math.max(this.seq, entry.seq); this.recent.push(entry);
    const keep = this.options.keep ?? 500; if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep);
  }
  private async rotateIfLarge() {
    try {
      if ((await stat(this.file!)).size < (this.options.rotateBytes ?? 64 * 1024 * 1024)) return;
      await rename(this.file!, this.file!.replace(/\.ndjson$/, "") + `-through-${this.seq}.ndjson`);
      this.torn = false;
    } catch { /* no file yet */ }
  }

  /** Entries after `after`, oldest first. `missed` is true when some of them are no longer held in memory. */
  since(after: number, limit = 100): { entries: FeedEntry[]; missed: boolean } {
    const entries = this.recent.filter(entry => entry.seq > after);
    const missed = after < this.seq && (entries.length === 0 || entries[0].seq > after + 1);
    return { entries: entries.slice(0, Math.max(1, limit)), missed };
  }
  latest(limit = 30): FeedEntry[] { return this.recent.slice(-Math.max(1, limit)); }
  subscribe(listener: (entry: FeedEntry) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get listenerCount() { return this.listeners.size; }
  /** Wait for writes in progress (shutdown, tests). */
  idle(): Promise<unknown> { return this.writing; }
}
