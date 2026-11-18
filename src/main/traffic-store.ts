// Canonical traffic history, owned by main. Bounded ring buffer (the old
// renderer kept every request forever and leaked); bodies above the display
// cap are truncated with a flag — the wire response is never affected.
import type { TrafficEntry } from '../shared/types';

export const TRAFFIC_CAP = 1000;
export const BODY_DISPLAY_CAP = 2 * 1024 * 1024; // 2 MB

function truncateBody(view: { body?: Uint8Array | string; truncated?: boolean }): void {
  const body = view.body;
  if (body && typeof body !== 'string' && body.length > BODY_DISPLAY_CAP) {
    view.body = body.slice(0, BODY_DISPLAY_CAP);
    view.truncated = true;
  }
  if (typeof body === 'string' && body.length > BODY_DISPLAY_CAP) {
    view.body = body.slice(0, BODY_DISPLAY_CAP);
    view.truncated = true;
  }
}

export class TrafficStore {
  private entries: TrafficEntry[] = [];
  /**
   * Monotonic and main-owned: never reset on clear, never reused across proxy
   * restarts, so a trafficId is a stable handle (needed for replay) for as long
   * as the entry lives. Tabs share one allocator, so an id is unique across
   * every tab and names one request on its own.
   */
  private readonly allocateId: () => number;

  constructor(
    private cap: number = TRAFFIC_CAP,
    allocateId?: () => number
  ) {
    let next = 1;
    this.allocateId = allocateId ?? (() => next++);
  }

  /** Assigns a fresh stable trafficId and appends the entry. */
  add(entry: TrafficEntry): TrafficEntry {
    truncateBody(entry.request);
    truncateBody(entry.response);
    entry.trafficId = this.allocateId();
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    return entry;
  }

  /**
   * Replaces the entry with the same trafficId in place (for streaming
   * updates). Returns undefined when that entry has since been evicted or
   * cleared — the update is then dropped rather than resurrecting the row.
   */
  update(entry: TrafficEntry): TrafficEntry | undefined {
    // Updates almost always target a recent entry: search from the end.
    const index = this.entries.findLastIndex((e) => e.trafficId === entry.trafficId);
    if (index < 0) return undefined;
    truncateBody(entry.request);
    truncateBody(entry.response);
    this.entries[index] = entry;
    return entry;
  }

  /** Changes how many entries are kept, evicting the oldest if it shrank. */
  setCap(cap: number): void {
    this.cap = cap;
    if (this.entries.length > cap) this.entries.splice(0, this.entries.length - cap);
  }

  get(trafficId: number): TrafficEntry | undefined {
    return this.entries.find((e) => e.trafficId === trafficId);
  }

  getAll(): TrafficEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
