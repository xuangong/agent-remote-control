import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';

/** M5: the live subscriptions open at one time never exceed the budget. A subscription ends with `closed`, `unsubscribe` or a closed socket. */
export function subscriptionsWithinBudget(transcript: Transcript, budget: number): InvariantResult {
  const open = new Map<number, Set<number>>();
  let peak = 0;
  const violations: Violation[] = [];
  let checked = 0;
  for (const entry of transcript) {
    if ('marker' in entry) { if (entry.marker === 'socket-close' && entry.connection !== undefined) open.delete(entry.connection); continue; }
    const subscription = entry.subscriptionId;
    if (subscription === undefined) continue;
    const set = open.get(entry.connection) ?? new Set<number>();
    open.set(entry.connection, set);
    if (entry.direction === 'browser->relay' && entry.message.type === 'subscribe') { set.add(subscription); checked += 1; }
    if ((entry.direction === 'relay->browser' && entry.message.type === 'closed') || (entry.direction === 'browser->relay' && entry.message.type === 'unsubscribe')) set.delete(subscription);
    const live = [...open.values()].reduce((sum, one) => sum + one.size, 0);
    if (live > peak) {
      peak = live;
      if (live > budget) violations.push({ message: `${live} live subscriptions, budget ${budget}`, at: entry.t });
    }
  }
  return result('subscriptions-within-budget', checked, violations);
}

/** M5: rows that did not change keep their element when the directory churns: every marked row is still the same element. */
export function unchangedRowsNotRerendered(page: PageReport): InvariantResult {
  const { survivors } = page;
  if (!survivors) return result('unchanged-rows-not-rerendered', 0, []);
  const lost = survivors.total - survivors.alive;
  return result('unchanged-rows-not-rerendered', survivors.total, lost > 0 ? [{ message: `${lost} of ${survivors.total} unchanged rows were re-created`, detail: survivors }] : []);
}

/** A series is stable when its last quarter stays within `growth` times the median of its first quarter plus a floor. */
export function stableSeries(name: string, values: number[], { growth = 1.5, floor = 0 }: { growth?: number; floor?: number } = {}): InvariantResult {
  if (values.length < 8) return result(name, 0, []);
  const quarter = Math.floor(values.length / 4);
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
  const early = median(values.slice(0, quarter));
  const late = median(values.slice(-quarter));
  const limit = early * growth + floor;
  return result(name, values.length, late > limit ? [{ message: `${name} grew from ${early} to ${late} (limit ${Math.round(limit)})` }] : []);
}

const PER_ROW_GROWTH = 1.25;
const HEAP_FLOOR = 5 * 1024 * 1024;

/**
 * M5 and M8: the page's heap holds no more than its conversations need. A page whose retained rows grow (M8) is compared per retained row
 * with a fresh page that loaded the same rows: the run's heap may be at most 1.25 times the fresh page's heap per row, plus a 5 MiB floor.
 * A page whose rows stay put (M5) keeps the stable heap series. Growing rows with no fresh page cannot tell a leak from a longer
 * conversation, so they are not judged; neither is a fresh page that holds more than a tenth more or fewer rows.
 */
export function memoryFlat(page: PageReport): InvariantResult {
  const resources = page.resources ?? [];
  const reference = page.memoryReference;
  const last = resources.at(-1);
  if (reference && last) {
    const soakedRows = last.retainedRows ?? 0, freshRows = reference.retainedRows ?? 0;
    if (soakedRows === 0 || freshRows === 0 || Math.abs(freshRows - soakedRows) > soakedRows * 0.1)
      return result('memory-flat', 0, []);
    const freshPerRow = reference.heapBytes / freshRows;
    const limit = freshPerRow * soakedRows * PER_ROW_GROWTH + HEAP_FLOOR;
    return result('memory-flat', 1, last.heapBytes > limit
      ? [{ message: `heap ${last.heapBytes} for ${soakedRows} rows against a fresh page's ${reference.heapBytes} for ${freshRows} rows (limit ${Math.round(limit)})`, detail: { soakedPerRow: Math.round(last.heapBytes / soakedRows), freshPerRow: Math.round(freshPerRow) } }]
      : []);
  }
  const rows = resources.map(sample => sample.retainedRows).filter((value): value is number => value !== undefined);
  if (rows.length >= 2 && rows.at(-1)! > rows[0]! * 1.5 + 20)
    return result('memory-flat', 0, []);
  return stableSeries('memory-flat', resources.map(sample => sample.heapBytes), { growth: 1.5, floor: HEAP_FLOOR });
}
/** M8: the number of rows held does not keep growing while the sessions stream a fixed amount. */
export const rowCountsStable = (page: PageReport): InvariantResult =>
  stableSeries('row-counts-stable', (page.resources ?? []).map(sample => sample.rows), { growth: 1.5, floor: 20 });
/** M8: the page's open socket count does not drift. */
export const socketCountsStable = (page: PageReport): InvariantResult =>
  stableSeries('socket-counts-stable', (page.resources ?? []).map(sample => sample.sockets), { growth: 1, floor: 2 });
