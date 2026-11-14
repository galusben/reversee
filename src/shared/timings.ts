// Turns the proxy's cumulative timing marks into consecutive phases, for the
// waterfall view and the HAR export. Platform-neutral.
import type { Timings } from './types';

export interface TimingPhase {
  key: 'dns' | 'connect' | 'tls' | 'wait' | 'download';
  label: string;
  /** Offset from the start of the request, ms. */
  startMs: number;
  durationMs: number;
}

const toMs = (ns: number | undefined): number | undefined =>
  ns === undefined ? undefined : ns / 1_000_000;

/**
 * The marks are nanoseconds since the request started, each taken when its
 * step FINISHED. DNS/connect/TLS are absent on a reused keep-alive socket, so
 * the phases present always tile [0, total] without gaps.
 */
export function timingPhases(timings: Timings): TimingPhase[] {
  const dns = toMs(timings.dnsLookup);
  const tcp = toMs(timings.tcpConnection);
  const tls = toMs(timings.tlsHandshake);
  const firstByte = toMs(timings.firstByte);
  const total = toMs(timings.total);

  const phases: TimingPhase[] = [];
  let cursor = 0;
  const add = (key: TimingPhase['key'], label: string, end: number | undefined): void => {
    if (end === undefined || end < cursor) return;
    phases.push({ key, label, startMs: cursor, durationMs: end - cursor });
    cursor = end;
  };
  add('dns', 'DNS lookup', dns);
  add('connect', 'TCP connect', tcp);
  add('tls', 'TLS handshake', tls);
  add('wait', 'Waiting (first byte)', firstByte);
  add('download', 'Download', total);
  return phases;
}

export function totalMs(timings: Timings): number | undefined {
  return toMs(timings.total);
}

/** "0.8 ms", "12 ms", "1.24 s" — compact and stable for a table column. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** "512 B", "1.4 kB", "2.31 MB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
