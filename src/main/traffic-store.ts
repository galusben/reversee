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

  constructor(private cap: number = TRAFFIC_CAP) {}

  /** Inserts the entry, replacing any previous entry with the same trafficId. */
  add(entry: TrafficEntry): TrafficEntry {
    truncateBody(entry.request);
    truncateBody(entry.response);
    const index = this.entries.findIndex((e) => e.trafficId === entry.trafficId);
    if (index >= 0) {
      this.entries[index] = entry;
    } else {
      this.entries.push(entry);
      if (this.entries.length > this.cap) {
        this.entries.splice(0, this.entries.length - this.cap);
      }
    }
    return entry;
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
