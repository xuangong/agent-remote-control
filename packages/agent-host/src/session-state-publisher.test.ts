import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostSessionState, HostSessionStates } from '@orchardworks/agent-remote-protocol';
import { createSessionStatePublisher } from './session-state-publisher.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

const state = (nativeSessionId: string, value: HostSessionState['state'], providerId = 'codex', updatedAt?: number): HostSessionState =>
  ({ providerId, nativeSessionId, state: value, ...(updatedAt === undefined ? {} : { updatedAt }) });

it('confirms every known state once a minute and sends open session changes within seconds', async () => {
  let live = [state('open', 'running', 'claude')];
  let codex = [state('thread', 'idle', 'codex', 5), state('open', 'idle', 'claude', 7)];
  const reads: string[] = [];
  const publisher = createSessionStatePublisher({ live: () => live, catalogs: () => [
    { providerId: 'codex', read: async () => { reads.push('codex'); return codex; } },
  ] });
  const reports: HostSessionStates[] = [];
  const stop = publisher.subscribe(report => reports.push(report));
  await vi.advanceTimersByTimeAsync(0);
  // The open session overrides its catalog state and keeps the catalog's update time.
  expect(reports).toEqual([{ full: true, states: [state('thread', 'idle', 'codex', 5), state('open', 'running', 'claude', 7)] }]);
  live = [state('open', 'waiting', 'claude')];
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reports[1]).toEqual({ full: false, states: [state('open', 'waiting', 'claude', 7)] });
  live = [];
  codex = [state('thread', 'running', 'codex', 9)];
  await vi.advanceTimersByTimeAsync(2_000);
  // A closed session falls back to what its catalog last said.
  expect(reports[2]).toEqual({ full: false, states: [state('open', 'idle', 'claude', 7)] });
  await vi.advanceTimersByTimeAsync(56_000);
  expect(reports.at(-1)).toEqual({ full: true, states: [state('thread', 'running', 'codex', 9)] });
  expect(reads).toEqual(['codex', 'codex']);
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reads).toEqual(['codex', 'codex']);
});

it('drops catalog states it could not read again in time and rarely rereads catalogs that add nothing', async () => {
  let failing = false, quietReads = 0;
  const publisher = createSessionStatePublisher({ live: () => [state('open', 'idle', 'claude')], catalogs: () => [
    { providerId: 'codex', read: async () => { if (failing) throw new Error('offline'); return [state('thread', 'running')]; } },
    { providerId: 'claude', read: async () => { quietReads++; return [state('open', 'idle', 'claude')]; } },
  ] });
  const reports: HostSessionStates[] = [];
  publisher.subscribe(report => reports.push(report));
  await vi.advanceTimersByTimeAsync(0);
  expect(reports[0]!.states.map(value => value.nativeSessionId)).toEqual(['thread', 'open']);
  failing = true;
  await vi.advanceTimersByTimeAsync(120_000);
  // Still trusted within three minutes of the last reading.
  expect(reports.filter(report => report.full).at(-1)!.states.map(value => value.nativeSessionId)).toEqual(['thread', 'open']);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reports.filter(report => report.full).at(-1)!.states.map(value => value.nativeSessionId)).toEqual(['open']);
  expect(quietReads).toBe(1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(quietReads).toBe(2);
});
