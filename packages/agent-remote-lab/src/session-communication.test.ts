import { expect, it, vi } from 'vitest';
import { communicationParticipants, communicationDirection, findSessionCommunication, loadSessionCommunication } from './session-communication.js';
import { replicaState } from './test/fixtures.js';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

const parent = { agentId: 'p', nativeSessionId: 'parent', providerId: 'codex', hostId: 'host', title: 'Renamed parent' };
const child = { ...parent, agentId: 'c', nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Renamed child' };
const entry: ProjectedTimelineEntry = { providerId: 'codex', seqStart: 4, seqEnd: 4, timestamp: '2026-09-29T00:00:00Z', resources: [], collapsed: [], sourceSeqRanges: [],
  item: { type: 'agent_communication', messageId: 'letter', sender: '/root', recipient: '/root/review', text: 'Task' } };
const received = { ...entry, turnId: 'child-turn' };
const state = (entries: ProjectedTimelineEntry[]) => ({ ...replicaState, timeline: { ...replicaState.timeline, entries } });
it('uses recorded receipt ownership and native references, not editable session titles', () => {
  const snapshots = [{ session: parent, state: state([entry]) }, { session: child, state: state([received]) }];
  expect(communicationParticipants(entry, parent, snapshots)).toEqual({ sender: parent, recipient: child });
  expect(communicationDirection(child, parent, [parent, child])).toBe('right');
  expect(communicationDirection(parent, child, [parent, child])).toBe('left');
  expect(communicationDirection(child, parent, [parent])).toBeUndefined();
  expect(communicationDirection(child, child, [parent, child])).toBeUndefined();
});
it('rejects ambiguous identities and ignores another Host with the same agent names', () => {
  const other = { ...child, hostId: 'other' };
  expect(communicationParticipants(entry, parent, [{ session: parent, state: state([entry]) }, { session: other, state: state([received]) }]).recipient).toBeUndefined();
  expect(communicationParticipants(entry, parent, [{ session: parent, state: state([entry]) }, { session: child, state: state([received]) },
    { session: { ...child, nativeSessionId: 'different' }, state: state([received]) }]).recipient).toBeUndefined();
});
it('matches the received message identity instead of a nearby timestamp or mirrored receipt', () => {
  expect(findSessionCommunication(state([entry, { ...received, item: { ...received.item, messageId: 'different' } } as ProjectedTimelineEntry]), entry)).toBeUndefined();
  expect(findSessionCommunication(state([received]), entry)).toBe(received);
});

it('loads older receiver pages, returns the exact receipt and stops on history replacement', async () => {
  let current = state([{ ...entry, seqStart: 100, item: { ...entry.item, messageId: 'recent' } } as ProjectedTimelineEntry]);
  current.timeline.hasOlder = true;
  const loadOlder = vi.fn(async () => { current = state([received, ...current.timeline.entries]); });
  const connection = { replica: { getState: () => current }, client: { loadOlder, getSessionState: () => ({ connection: 'ready' }), subscribeSessionState: () => () => {} } } as unknown as Parameters<typeof loadSessionCommunication>[0];
  expect((await loadSessionCommunication(connection, entry, new AbortController().signal)).key).toContain('letter');
  expect(loadOlder).toHaveBeenCalledTimes(1);
  current = state([]); current.timeline.hasOlder = true;
  await expect(loadSessionCommunication(connection, entry, new AbortController().signal)).rejects.toThrow('does not contain');
  current = state([{ ...entry, seqStart: 100, item: { ...entry.item, messageId: 'recent' } } as ProjectedTimelineEntry]); current.timeline.hasOlder = true;
  loadOlder.mockImplementation(async () => { current = { ...current, timeline: { ...current.timeline, epoch: 'replaced', entries: [received] } }; });
  await expect(loadSessionCommunication(connection, entry, new AbortController().signal)).rejects.toThrow('changed');
});
it('does not interpret a missing turn as proof of the sending session', () => {
  expect(communicationParticipants(entry, parent, [{ session: parent, state: state([entry]) }]).sender).toBeUndefined();
});

it('locates the sender copy by message identity without requiring a received turn', async () => {
  expect(findSessionCommunication(state([received, entry]), entry, 'sender')).toBe(entry);
  expect(findSessionCommunication(state([received]), entry, 'sender')).toBeUndefined();
  let current = state([{ ...entry, seqStart: 100, item: { ...entry.item, messageId: 'recent' } } as ProjectedTimelineEntry]);
  current.timeline.hasOlder = true;
  const loadOlder = vi.fn(async () => { current = state([entry, ...current.timeline.entries]); });
  const connection = { replica: { getState: () => current }, client: { loadOlder, getSessionState: () => ({ connection: 'ready' }), subscribeSessionState: () => () => {} } } as unknown as Parameters<typeof loadSessionCommunication>[0];
  expect((await loadSessionCommunication(connection, received, new AbortController().signal, 'sender')).key).toContain('letter');
  expect(loadOlder).toHaveBeenCalledTimes(1);
});
