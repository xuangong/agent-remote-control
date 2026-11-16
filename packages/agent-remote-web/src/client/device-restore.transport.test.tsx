import { act, useSyncExternalStore } from 'react';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

import { AgentTimeline } from '../react/AgentTimeline.js';
import { AgentReplica } from '../replica/store.js';
import { journalRelay, text, type Row } from '../test/journal-relay.js';
import { render } from '../test/setup.js';
import { HttpWebSocketTransport } from './http-websocket-transport.js';
import { RemoteSessionClient } from './remote-session-client.js';

const snapshot: AgentSnapshotPayload = {
  id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', status: 'idle', activeTurn: null, pendingInteractions: [],
  capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
  runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' },
};
const entryOf = (row: Row): ProjectedTimelineEntry => ({ providerId: 'copilot', itemKey: row.key, item: row.item, timestamp: `2026-11-16T00:00:${String(row.seq % 60).padStart(2, '0')}.000Z`,
  seqStart: row.seq, seqEnd: row.seq, sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }], collapsed: [], resources: [] });
/** What a device stored after reading `rows` in `epoch`. */
const stored = (rows: Row[], epoch: string, hasOlder = false) => ({ snapshot, epoch, nextSeq: rows.length + 1, hasOlder, entries: rows.map(entryOf) });

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

/** A replica restored from a record, then connected to a journal-serving Relay over a real WebSocket. */
async function reopen(options: { served: Row[]; servedEpoch?: string; record: ReturnType<typeof stored>; connect?: boolean }) {
  const relay = journalRelay();
  closers.push(() => relay.close());
  relay.setRows(options.served, options.servedEpoch ?? 'epoch-one');
  const url = await relay.listen();
  const transport = new HttpWebSocketTransport(url, { WebSocket: WebSocket as never, sessionChannels: true });
  const replica = new AgentReplica();
  replica.restoreFromDevice(options.record);
  const client = new RemoteSessionClient('one', transport, replica);
  const statuses: string[] = [];
  const unsubscribe = client.subscribeStatus(status => statuses.push(status));
  closers.push(() => { unsubscribe(); client.stop(); transport.dispose(); });
  return { relay, replica, client, statuses, start: async () => { client.start(); await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 10 }); } };
}

function Screen({ replica }: { replica: AgentReplica }) {
  const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
  return <AgentTimeline state={state} />;
}
const nodesByKey = (container: HTMLElement) => new Map([...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey!, node]));
const settle = (ms = 60) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const rows = (count: number) => Array.from({ length: count }, (_, index) => text(`k${index}`, index + 1, `Reply ${index}`));

it('shows the stored rows before any connection, keyed by item key, and says they came from the device', async () => {
  const { replica } = await reopen({ served: rows(3), record: stored(rows(3), 'epoch-one') });
  const container = await render(<Screen replica={replica} />);
  expect([...nodesByKey(container).keys()]).toEqual(['k0', 'k1', 'k2']);
  expect(replica.getState().timeline).toMatchObject({ initialized: true, epoch: 'epoch-one', nextSeq: 4, restoredFromDevice: true });
});

it('continues the same epoch from the stored cursor with one after request, keeps unchanged rows mounted and confirms the display', async () => {
  const session = await reopen({ served: [...rows(3), text('k3', 4, 'Reply 3')], record: stored(rows(3), 'epoch-one') });
  const container = await render(<Screen replica={session.replica} />);
  const before = nodesByKey(container);
  await session.start();
  await settle();
  expect(session.relay.requests.map(request => request.direction)).toEqual(['after']);
  expect(session.relay.requests[0]).toMatchObject({ epoch: 'epoch-one', seq: 3, via: 'socket' });
  const after = nodesByKey(container);
  expect([...after.keys()]).toEqual(['k0', 'k1', 'k2', 'k3']);
  for (const key of ['k0', 'k1', 'k2']) expect(after.get(key)).toBe(before.get(key));
  expect(session.replica.getState().timeline.restoredFromDevice).toBeUndefined();
});

it('turns a cursor the Relay does not hold into a replacement merged by key, never through an empty state', async () => {
  const served = [text('k0', 1, 'Reply 0'), text('k1', 2, 'Reply 1 changed'), text('n1', 3, 'New'), text('k2', 4, 'Reply 2')];
  const session = await reopen({ served, servedEpoch: 'epoch-two', record: stored(rows(3), 'epoch-one') });
  const container = await render(<Screen replica={session.replica} />);
  const sizes: number[] = [];
  session.replica.subscribe(() => sizes.push(session.replica.getState().timeline.entries.length));
  const before = nodesByKey(container);
  await session.start();
  await settle();
  expect(session.relay.requests.map(request => request.direction)).toEqual(['after', 'tail']);
  const after = nodesByKey(container);
  expect([...after.keys()]).toEqual(['k0', 'k1', 'n1', 'k2']);
  expect(after.get('k0')).toBe(before.get('k0'));
  expect(after.get('k2')).toBe(before.get('k2'));
  expect(after.get('k1')?.textContent).toContain('Reply 1 changed');
  expect(Math.min(...sizes)).toBeGreaterThan(0);
  expect(session.replica.getState().timeline).toMatchObject({ epoch: 'epoch-two' });
  expect(session.replica.getState().timeline.pendingEpoch).toBeUndefined();
  expect(session.replica.getState().timeline.restoredFromDevice).toBeUndefined();
});

it('reads older history over the session wire, so a journal-served session scrolls back without its Controller', async () => {
  const served = Array.from({ length: 6 }, (_, index) => text(`k${index}`, index + 1, `Reply ${index}`));
  const session = await reopen({ served, record: { ...stored(served.slice(3), 'epoch-one', true), nextSeq: 7 } });
  await session.start();
  session.relay.requests.length = 0;
  await session.client.loadOlder();
  expect(session.relay.requests).toMatchObject([{ direction: 'before', via: 'socket' }]);
  expect(session.replica.getState().timeline.entries.map(entry => entry.itemKey)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
});

it('does not restore into a replica that already read the session', async () => {
  const session = await reopen({ served: rows(2), record: stored(rows(2), 'epoch-one') });
  await session.start();
  session.replica.restoreFromDevice(stored([text('old', 1, 'Old')], 'epoch-old'));
  expect(session.replica.getState().timeline.entries.map(entry => entry.itemKey)).toEqual(['k0', 'k1']);
});
