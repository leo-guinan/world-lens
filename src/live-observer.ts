import { diffObservation, type ObservationChange, type ObservationReceiptLike } from "./live-observation.ts";

export interface LiveObserverState {
  active: boolean;
  url: string | null;
  intervalSeconds: number | null;
  lastReceiptId: string | null;
  polls: number;
  changes: number;
  lastError: string | null;
}

export class LiveObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private previous: ObservationReceiptLike | null = null;
  private state: LiveObserverState = { active: false, url: null, intervalSeconds: null, lastReceiptId: null, polls: 0, changes: 0, lastError: null };

  constructor(
    private readonly observe: (url: string) => Promise<ObservationReceiptLike>,
    private readonly onReceipt: (r: ObservationReceiptLike) => Promise<void>,
    private readonly onChange: (e: ObservationChange, receipt: ObservationReceiptLike) => Promise<void>,
    /** When given, a poll that shows nothing new is handed here to be thrown away, and the receipt it matched
     * stays the one later changes are compared with. Without this, an observer left running stores a receipt
     * and a screenshot for every poll, changed or not, for as long as it runs. */
    private readonly onUnchanged?: (duplicate: ObservationReceiptLike) => Promise<void>,
  ) {}

  getState(): LiveObserverState { return { ...this.state }; }

  async start(url: string, intervalSeconds: number) {
    this.stop();
    this.previous = null;
    this.state = { active: true, url, intervalSeconds, lastReceiptId: null, polls: 0, changes: 0, lastError: null };
    await this.pollOnce(); // first observation is baseline: never surprise the live room
    this.timer = setInterval(() => { void this.pollOnce(); }, intervalSeconds * 1000);
    return this.getState();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = { ...this.state, active: false };
  }

  async pollOnce() {
    if (this.busy || !this.state.active || !this.state.url) return;
    this.busy = true;
    try {
      const receipt = await this.observe(this.state.url);
      await this.onReceipt(receipt);
      const event = diffObservation(this.previous, receipt);
      if (event.kind === "unchanged" && this.onUnchanged) {
        this.state = { ...this.state, polls: this.state.polls + 1, lastError: null };
        await this.onUnchanged(receipt);
        return;
      }
      this.previous = receipt;
      this.state = { ...this.state, lastReceiptId: receipt.id, polls: this.state.polls + 1, changes: this.state.changes + (event.changed ? 1 : 0), lastError: null };
      if (event.changed) await this.onChange(event, receipt);
    } catch (error) {
      this.state = { ...this.state, lastError: error instanceof Error ? error.message : "observation failed" };
    } finally {
      this.busy = false;
    }
  }
}
