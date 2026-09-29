import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender, unmount } from '../test/setup.js';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { findTimelineMatches, type TimelineSearchOptions } from '../client/timeline-search.js';
import { TimelineSearch } from './TimelineSearch.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay } from './TimelineDisplay.js';

const entry = (seq: number, text: string): ProjectedTimelineEntry => ({ providerId: 'recorded', seqStart: seq, seqEnd: seq,
  timestamp: '2026-09-29T00:00:00Z', item: { type: 'assistant_message', text }, resources: [], collapsed: [], sourceSeqRanges: [] });
const state = (entries = [entry(10, '中文 latest')], hasOlder = true): AgentReplicaState => ({ ...createReplicaState(),
  timeline: { epoch: 'epoch', initialized: true, entries, hasOlder, nextSeq: 11, pendingLive: [] } });
async function query(container: HTMLElement, value: string) {
  await act(async () => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}
afterEach(() => vi.useRealTimers());

it('merges unloaded results, navigates, filters history, and marks incomplete searches', async () => {
  vi.useFakeTimers();
  const selected = vi.fn(async () => {});
  const search = vi.fn(async (text: string, options?: TimelineSearchOptions) => ({ matches: findTimelineMatches('epoch', [entry(1, '中文 old')], text, options?.scope), scanned: 20 }));
  const container = await render(<TimelineSearch state={state()} search={search} onSelect={selected} onClose={() => {}} />);
  await query(container, '中文');
  expect(search.mock.calls[0]?.[1]?.scope).toBe('messages');
  expect(container.textContent).toContain('2 matching messages');
  const result = [...container.querySelectorAll<HTMLButtonElement>('ol button')].find(button => button.textContent?.includes('old'))!;
  await act(async () => result.click());
  expect(selected.mock.calls[0]?.[0]).toMatchObject({ seq: 1 });
  await act(async () => {
    const select = container.querySelector('select')!; select.value = 'reasoning'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(search.mock.calls.at(-1)?.[1]?.scope).toBe('reasoning');
  expect(container.textContent).toContain('0 matching messages');
  await rerender(container, <TimelineSearch state={state()} onSelect={selected} onClose={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(container.textContent).toContain('Partial results');
  expect(container.textContent).not.toContain('All available history searched');
});

it('ignores a late scan after changing query or unmounting', async () => {
  vi.useFakeTimers();
  const scans: { options?: TimelineSearchOptions; resolve: (value: { matches: ReturnType<typeof findTimelineMatches>; scanned: number }) => void }[] = [];
  const search = vi.fn((_query: string, options?: TimelineSearchOptions) => new Promise<{ matches: ReturnType<typeof findTimelineMatches>; scanned: number }>(resolve => scans.push({ options, resolve })));
  const container = await render(<TimelineSearch state={state()} search={search} onSelect={async () => { throw new Error('jump failed'); }} onClose={() => {}} />);
  await query(container, '中文');
  await query(container, 'new');
  expect(scans[0]?.options?.signal?.aborted).toBe(true);
  await act(async () => scans[0]?.resolve({ matches: findTimelineMatches('epoch', [entry(1, '中文 stale')], '中文'), scanned: 100 }));
  expect(container.textContent).not.toContain('stale');
  await unmount(container);
  expect(scans[1]?.options?.signal?.aborted).toBe(true);
});

it('retains partial results on failure and lets readers retry the scan and jump', async () => {
  vi.useFakeTimers();
  const search = vi.fn().mockRejectedValueOnce(new Error('History disconnected')).mockResolvedValue({ matches: [], scanned: 1 });
  const selected = vi.fn().mockRejectedValueOnce(new Error('Jump disconnected')).mockResolvedValue(undefined);
  const container = await render(<TimelineSearch state={state()} search={search} onSelect={selected} onClose={() => {}} />);
  await query(container, '中文');
  expect(container.textContent).toContain('History disconnected');
  expect(container.textContent).toContain('Partial results');
  expect(container.querySelectorAll('ol li')).toHaveLength(1);
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(container.textContent).toContain('All available history searched');
  await act(async () => container.querySelector<HTMLButtonElement>('ol button')!.click());
  expect(container.textContent).toContain('Jump disconnected');
  await act(async () => container.querySelector<HTMLButtonElement>('ol button')!.click());
  expect(container.textContent).not.toContain('Jump disconnected');
  expect(selected).toHaveBeenCalledTimes(2);
});

it('reveals and expands a matching hidden item without changing Content only for the rest', async () => {
  const reasoning = { ...entry(2, ''), item: { type: 'reasoning' as const, text: 'hidden answer' } };
  const other = { ...entry(3, ''), item: { type: 'reasoning' as const, text: 'unrelated reasoning' } };
  const key = findTimelineMatches('epoch', [reasoning], 'answer', 'reasoning')[0]!.key;
  const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline state={state([reasoning, other], false)} searchEntryKey={key} /></TimelineDisplay.Provider>);
  expect(container.querySelector('.agent-reasoning-toggle')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-inspected]')?.textContent).toContain('hidden answer');
  expect(container.textContent).not.toContain('unrelated reasoning');
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-reasoning-toggle')!.click());
  expect(container.querySelector('.agent-reasoning-toggle')?.getAttribute('aria-expanded')).toBe('false');
});
