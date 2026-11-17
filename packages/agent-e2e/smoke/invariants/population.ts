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

/** M5 and M8: the page's heap does not grow past 1.5 times its early level, with a 5 MiB floor for noise. */
export const memoryFlat = (page: PageReport): InvariantResult =>
  stableSeries('memory-flat', (page.resources ?? []).map(sample => sample.heapBytes), { growth: 1.5, floor: 5 * 1024 * 1024 });
/** M8: the number of rows held does not keep growing while the sessions stream a fixed amount. */
export const rowCountsStable = (page: PageReport): InvariantResult =>
  stableSeries('row-counts-stable', (page.resources ?? []).map(sample => sample.rows), { growth: 1.5, floor: 20 });
/** M8: the page's open socket count does not drift. */
export const socketCountsStable = (page: PageReport): InvariantResult =>
  stableSeries('socket-counts-stable', (page.resources ?? []).map(sample => sample.sockets), { growth: 1, floor: 2 });
