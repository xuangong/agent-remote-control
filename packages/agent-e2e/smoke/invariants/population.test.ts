import { describe, expect, it } from 'vitest';
import { page, transcript } from './builders.js';
import { memoryFlat, rowCountsStable, socketCountsStable, stableSeries, subscriptionsWithinBudget, unchangedRowsNotRerendered } from './population.js';

describe('subscriptions stay within budget', () => {
  const subscribe = (b: ReturnType<typeof transcript>, t: number, id: number) => b.send(t, 'subscribe', { agentId: `a${id}` }, { subscriptionId: id });
  it('passes when closed subscriptions free their place', () => {
    const b = transcript();
    for (let id = 1; id <= 3; id += 1) subscribe(b, id, id);
    b.receive(10, 'closed', { code: 1000 }, { subscriptionId: 1 });
    subscribe(b, 11, 4);
    expect(subscriptionsWithinBudget(b.build(), 3).status).toBe('passed');
  });
  it('fails when more subscriptions are live than the budget allows', () => {
    const b = transcript();
    for (let id = 1; id <= 4; id += 1) subscribe(b, id, id);
    expect(subscriptionsWithinBudget(b.build(), 3).violations[0]?.message).toMatch(/4 live subscriptions/);
  });
  it('frees every subscription of a closed socket', () => {
    const b = transcript();
    for (let id = 1; id <= 3; id += 1) subscribe(b, id, id);
    b.marker(5, 'socket-close', undefined, 1).onConnection(2);
    for (let id = 1; id <= 3; id += 1) subscribe(b, 6 + id, id);
    expect(subscriptionsWithinBudget(b.build(), 3).status).toBe('passed');
  });
});

describe('unchanged rows are not re-rendered', () => {
  it('passes when every marked row is still the same element', () => {
    expect(unchangedRowsNotRerendered(page({ survivors: { total: 30, alive: 30 } })).status).toBe('passed');
  });
  it('fails when churn re-created rows that did not change', () => {
    expect(unchangedRowsNotRerendered(page({ survivors: { total: 30, alive: 12 } })).violations[0]?.message).toMatch(/18 of 30/);
  });
});

describe('memory, row and socket counts are flat', () => {
  const flat = Array.from({ length: 16 }, (_, at) => ({ t: at, heapBytes: 50e6 + (at % 3) * 1e6, rows: 100, sockets: 3 }));
  it('passes for a flat series', () => {
    const report = page({ resources: flat });
    expect([memoryFlat(report), rowCountsStable(report), socketCountsStable(report)].map(v => v.status)).toEqual(['passed', 'passed', 'passed']);
  });
  it('fails for a heap that doubles, rows that keep growing and sockets that leak', () => {
    const growing = flat.map((one, at) => ({ ...one, heapBytes: 50e6 * (1 + at / 8), rows: 100 + at * 20, sockets: 3 + at }));
    const report = page({ resources: growing });
    expect([memoryFlat(report), rowCountsStable(report), socketCountsStable(report)].map(v => v.status)).toEqual(['failed', 'failed', 'failed']);
  });
  it('needs enough samples to judge', () => {
    expect(stableSeries('x', [1, 2, 3]).status).toBe('not_exercised');
  });
});
