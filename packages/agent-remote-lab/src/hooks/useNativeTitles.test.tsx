import { act, useEffect, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { useNativeTitles } from './useNativeTitles.js';
import { render } from '../test/setup.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

type Describe = Parameters<typeof useNativeTitles>[0]['describe'];

function harness(entries: SessionEntry[], describe: Describe, confirmed?: ReadonlyMap<string, string>) {
  const applied: SessionEntry[] = [];
  let retrigger!: () => void;
  function Harness() {
    const [trigger, setTrigger] = useState(0);
    retrigger = () => setTrigger(value => value + 1);
    useNativeTitles({ entries, confirmed, describe, apply: session => { applied.push(session); }, trigger: String(trigger) });
    return null;
  }
  return { applied, render: () => render(<Harness />), retrigger: () => act(async () => retrigger()) };
}

const entry = (nativeSessionId: string, title: string, hostId = 'host-1'): SessionEntry => ({ hostId, providerId: 'claude', nativeSessionId, title });

it('replaces placeholder titles with the native title the Host reports', async () => {
  const describe = vi.fn<Describe>(async (_hostId, _providerId, nativeSessionId) => `Native ${nativeSessionId}`);
  const h = harness([entry('linked', 'Session'), entry('created', 'New session'), entry('hosted', 'New Claude Code session'),
    entry('named', 'Release notes')], describe);
  await h.render();
  await vi.waitFor(() => expect(h.applied).toHaveLength(3));
  expect(h.applied).toEqual([
    { hostId: 'host-1', providerId: 'claude', nativeSessionId: 'linked', title: 'Native linked' },
    { hostId: 'host-1', providerId: 'claude', nativeSessionId: 'created', title: 'Native created' },
    { hostId: 'host-1', providerId: 'claude', nativeSessionId: 'hosted', title: 'Native hosted' },
  ]);
  expect(describe.mock.calls.map(call => call[2])).toEqual(['linked', 'created', 'hosted']);
});

it('leaves confirmed titles, sessions of the local directory and other titles alone', async () => {
  const describe = vi.fn<Describe>(async () => 'Native');
  const h = harness([entry('renamed', 'Session'), entry('local', 'Session', 'local'), entry('named', 'Plan')], describe,
    new Map([[sessionKey(entry('renamed', 'Session')), 'Session']]));
  await h.render();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(describe).not.toHaveBeenCalled();
  expect(h.applied).toEqual([]);
});

it('asks again after a while when nothing else changes', async () => {
  vi.useFakeTimers();
  try {
    let title: string | undefined;
    const describe = vi.fn<Describe>(async () => title);
    const h = harness([entry('docked', 'New Claude Code session')], describe);
    await h.render();
    expect(describe).toHaveBeenCalledTimes(1);
    title = 'Summarize the release';
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(describe).toHaveBeenCalledTimes(2);
    expect(h.applied.map(session => session.title)).toEqual(['Summarize the release']);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(describe).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('keeps asking on its own clock while the page re-renders more often than that', async () => {
  vi.useFakeTimers();
  try {
    let title: string | undefined;
    const describe = vi.fn<Describe>(async () => title);
    const applied: SessionEntry[] = [];
    function Busy() {
      // A running session re-renders the page every few seconds with a new entry list.
      const [, setRender] = useState(0);
      useEffect(() => { const timer = setInterval(() => setRender(value => value + 1), 2_000); return () => clearInterval(timer); }, []);
      useNativeTitles({ entries: [entry('busy', 'New session')], describe, apply: session => { applied.push(session); }, trigger: 'running' });
      return null;
    }
    await render(<Busy />);
    title = 'Plan the migration';
    // Each step lets the page re-render before the clock moves on.
    for (let step = 0; step < 6; step++) await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(applied.map(session => session.title)).toEqual(['Plan the migration']);
  } finally { vi.useRealTimers(); }
});

it('asks again after a turn while the native session has no title yet, and stops when the Host refuses', async () => {
  let title: string | undefined;
  const describe = vi.fn<Describe>(async (_hostId, _providerId, nativeSessionId) => {
    if (nativeSessionId === 'shared') throw Object.assign(new Error('Session commands are available to the Host owner.'), { status: 403 });
    return title;
  });
  const h = harness([entry('created', 'New session'), entry('shared', 'Session')], describe);
  await h.render();
  await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
  expect(h.applied).toEqual([]);
  title = 'Explain the failing test';
  await h.retrigger();
  await vi.waitFor(() => expect(h.applied).toHaveLength(1));
  expect(h.applied[0]!.title).toBe('Explain the failing test');
  // The refused session is not asked again.
  expect(describe.mock.calls.filter(call => call[2] === 'shared')).toHaveLength(1);
});
