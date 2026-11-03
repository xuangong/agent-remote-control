import type { HostedRecordKind, RelayStateCommitMetrics } from '@orchardworks/agent-remote-hosted';

export interface StateCommitLogContext { runtimeInstanceId: string; workerVersionId?: string }
interface Summary {
  startedAt: number; commits: number; encodedRecords: number; writtenRecords: number;
  durationMs: { total: number; max: number; change: number; capacity: number; store: number };
  records?: number; bytes?: number;
}
const rounded = (value: number) => Math.round(value * 10) / 10;

/**
 * Operator diagnostics of the Relay state, in the Worker log (`wrangler tail`): one line per minute with commits, and one per
 * cache mismatch. Counts, sizes and durations only, of the whole Relay; never account, session or content data.
 * The runtime's clock advances only at I/O, so a commit's duration includes its write but its CPU steps may read as zero.
 */
export function createStateCommitLog(context: StateCommitLogContext, loaded: { records: number; bytes: number; durationMs: number },
  write: (line: string) => void = line => console.log(line), now = Date.now, windowMs = 60_000) {
  let summary: Summary | undefined, first = true;
  function flush() {
    if (!summary) return;
    const { startedAt, durationMs, ...counts } = summary;
    write(JSON.stringify({ event: 'relay_state_commits', ...context, windowMs: now() - startedAt, ...counts,
      durationMs: { total: rounded(durationMs.total), max: rounded(durationMs.max), change: rounded(durationMs.change), capacity: rounded(durationMs.capacity), store: rounded(durationMs.store) },
      ...(first ? { loaded: { ...loaded, durationMs: rounded(loaded.durationMs) } } : {}) }));
    summary = undefined; first = false;
  }
  return {
    commit(metrics: RelayStateCommitMetrics) {
      summary ??= { startedAt: now(), commits: 0, encodedRecords: 0, writtenRecords: 0, durationMs: { total: 0, max: 0, change: 0, capacity: 0, store: 0 } };
      summary.commits++;
      summary.durationMs.total += metrics.durationMs; summary.durationMs.max = Math.max(summary.durationMs.max, metrics.durationMs);
      summary.durationMs.change += metrics.changeMs; summary.durationMs.capacity += metrics.capacityMs; summary.durationMs.store += metrics.storeMs;
      if (metrics.store) {
        summary.encodedRecords += metrics.store.encoded; summary.writtenRecords += metrics.store.written;
        summary.records = metrics.store.records; summary.bytes = metrics.store.bytes;
      }
      if (now() - summary.startedAt >= windowMs) flush();
    },
    mismatch(cache: 'store' | 'capacity', kinds: HostedRecordKind[]) {
      write(JSON.stringify({ event: 'relay_state_cache_mismatch', ...context, cache, kinds }));
    },
  };
}
