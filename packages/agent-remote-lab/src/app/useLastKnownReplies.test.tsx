import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionStatesView } from '@orchardworks/agent-client';
import { buildGroup, buildView, buildWindow } from '../test/window-builders.js';
import { renderHook } from '../test/render-hook.js';
import { SharedFeeds } from '../kernel/shared-feeds.js';
import { readStoredReplies, writeStoredReplies } from '../kernel/stored-replies.js';
import { sessionKey } from '../kernel/session-tree.js';
import { useLastKnownReplies } from './useLastKnownReplies.js';

afterEach(() => { localStorage.clear(); vi.useRealTimers(); });
const scope = 'https://relay.test/u/' + 'a'.repeat(64) + '/';
const view = buildView('bot1');
const group = buildGroup(buildWindow([view]));
const key = sessionKey(view.binding!);
const states = (reply?: { replyAt: number; preview: string }): SessionStatesView => ({ state: () => ({ state: 'idle' }), reply: () => reply, host: () => ({ online: true }) });

it('answers with the reply the device last saw before any live state arrives, and nothing without a lease to read', async () => {
  writeStoredReplies(scope, new Map([[key, { replyAt: 7, preview: 'Done earlier.' }]]));
  const reading = await renderHook(() => useLastKnownReplies(scope, true, [group], new SharedFeeds()));
  expect(reading.result.current(view.binding!)).toEqual({ replyAt: 7, preview: 'Done earlier.' });
  const blocked = await renderHook(() => useLastKnownReplies(scope, false, [group], new SharedFeeds()));
  expect(blocked.result.current(view.binding!)).toBeUndefined();
});

it('remembers the live reply of each assistant for the next start', async () => {
  vi.useFakeTimers();
  const feeds = new SharedFeeds();
  await renderHook(() => useLastKnownReplies(scope, true, [group], feeds));
  await act(async () => feeds.set({ states: states({ replyAt: 11, preview: 'Fresh.' }) }));
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(readStoredReplies(scope).get(key)).toEqual({ replyAt: 11, preview: 'Fresh.' });
});
