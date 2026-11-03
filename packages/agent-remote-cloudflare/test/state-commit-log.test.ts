import { expect, test } from 'vitest';
import { createStateCommitLog } from '../src/state-commit-log.js';

test('summarizes a minute of commits in one line, with what loading took in the first', () => {
  const lines: string[] = []; let now = 0;
  const log = createStateCommitLog({ runtimeInstanceId: 'runtime', workerVersionId: 'version' }, { records: 50, bytes: 7_000_000, durationMs: 41.26 }, line => lines.push(line), () => now);
  const commit = (durationMs: number, encoded: number) => log.commit({ durationMs, changeMs: 0.1, capacityMs: 0.4, storeMs: durationMs - 0.5,
    store: { records: 52, bytes: 7_100_000, encoded, written: encoded } });
  commit(2, 1); now = 30_000; commit(3.04, 2);
  expect(lines).toEqual([]);
  now = 60_000; commit(1, 1);
  now = 200_000; commit(5, 3); now = 260_000; commit(1, 1);
  expect(lines.map(line => JSON.parse(line))).toEqual([
    { event: 'relay_state_commits', runtimeInstanceId: 'runtime', workerVersionId: 'version', windowMs: 60_000, commits: 3, encodedRecords: 4, writtenRecords: 4, records: 52, bytes: 7_100_000,
      durationMs: { total: 6, max: 3, change: 0.3, capacity: 1.2, store: 4.5 }, loaded: { records: 50, bytes: 7_000_000, durationMs: 41.3 } },
    { event: 'relay_state_commits', runtimeInstanceId: 'runtime', workerVersionId: 'version', windowMs: 60_000, commits: 2, encodedRecords: 4, writtenRecords: 4, records: 52, bytes: 7_100_000,
      durationMs: { total: 6, max: 5, change: 0.2, capacity: 0.8, store: 5 } },
  ]);
  log.mismatch('store', ['session']);
  expect(JSON.parse(lines.at(-1)!)).toEqual({ event: 'relay_state_cache_mismatch', runtimeInstanceId: 'runtime', workerVersionId: 'version', cache: 'store', kinds: ['session'] });
});
