// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentTimeline } from '../react/AgentTimeline.js';
import { journalRelay, text, type Row } from '../test/journal-relay.js';
import { render } from '../test/setup.js';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function openSession(options: { echoFlag?: boolean; rows: Row[] }) {
  const relay = journalRelay(options);
  closers.push(() => relay.close());
  relay.setRows(options.rows);
  const url = await relay.listen();
  const transport = new HttpWebSocketTransport(url, { WebSocket: WebSocket as never, sessionChannels: true });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('one', transport, replica);
  const statuses: string[] = [];
  const unsubscribe = client.subscribeStatus(status => statuses.push(status));
  closers.push(() => { unsubscribe(); client.stop(); transport.dispose(); });
  client.start();
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 10 });
  return { relay, replica, client, transport, statuses };
}

const renders = vi.hoisted(() => vi.fn());
vi.mock('../react/TimelineEntry.js', async original => {
  const module = await original<typeof import('../react/TimelineEntry.js')>();
  return { ...module, TimelineEntry: (props: Parameters<typeof module.TimelineEntry>[0]) => { renders(props.entryKey); return <module.TimelineEntry {...props} />; } };
});

function Screen({ replica }: { replica: AgentReplica }) {
  const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
  return <div><AgentTimeline state={state} processMode="full" /><textarea data-testid="composer" defaultValue="" /></div>;
}
const nodesByKey = (container: HTMLElement) => new Map([...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey!, node]));
const settle = (ms = 80) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

it('absorbs a replacement: unchanged rows keep their nodes and render no more, the changed row updates in place, the composer is untouched and the timeline is never empty', async () => {
  const { relay, replica } = await openSession({ rows: Array.from({ length: 10 }, (_, index) => text(`k${index}`, index + 1, `Reply ${index}`, 'reasoning')) });
  expect(relay.negotiates[0]).toMatchObject({ type: 'negotiate', itemKeys: true });
  const container = await render(<Screen replica={replica} />);
  const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')!;
  await act(async () => { composer.focus(); composer.value = 'a draft in progress'; composer.setSelectionRange(2, 7); });
  const sizes: number[] = [];
  replica.subscribe(() => sizes.push(replica.getState().timeline.entries.length));
  const before = nodesByKey(container);
  expect([...before.keys()]).toEqual(Array.from({ length: 10 }, (_, index) => `k${index}`));
  renders.mockClear();

  const release = relay.holdTails();
  // k4 changes, k7 is gone, a new row sits before k9, and every later sequence moves.
  const next = [0, 1, 2, 3, 4, 5, 6, 8].map((index, position) => text(`k${index}`, position + 1, index === 4 ? 'Reply 4 changed' : `Reply ${index}`, 'reasoning'));
  relay.replace([...next, text('n1', 9, 'Fresh reply'), text('k9', 10, 'Reply 9', 'reasoning')], 'epoch-two');
  await vi.waitFor(() => expect(replica.getState().timeline.pendingEpoch).toBe('epoch-two'));
  expect(nodesByKey(container).size).toBe(10);
  release();
  await vi.waitFor(() => expect(replica.getState().timeline.epoch).toBe('epoch-two'));
  await settle();

  const after = nodesByKey(container);
  expect([...after.keys()]).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k8', 'n1', 'k9']);
  for (const key of ['k0', 'k1', 'k2', 'k3', 'k5', 'k6', 'k8', 'k9']) expect(after.get(key)).toBe(before.get(key));
  expect(after.get('k4')).toBe(before.get('k4'));
  expect(after.get('k4')?.textContent).toContain('Reply 4 changed');
  expect(new Set(renders.mock.calls.map(call => call[0]))).toEqual(new Set(['k4', 'n1']));
  expect(Math.min(...sizes)).toBeGreaterThan(0);
  expect(replica.getState().timeline.pendingEpoch).toBeUndefined();
  expect(composer.isConnected).toBe(true);
  expect({ value: composer.value, focused: document.activeElement === composer, start: composer.selectionStart, end: composer.selectionEnd }).toEqual({ value: 'a draft in progress', focused: true, start: 2, end: 7 });
});

it('continues the same epoch after a reconnect with one after request and no tail', async () => {
  const { relay, replica, statuses } = await openSession({ rows: [text('a', 1, 'A'), text('b', 2, 'B')] });
  relay.requests.length = 0;
  statuses.length = 0;
  relay.setRows([text('a', 1, 'A'), text('b', 2, 'B'), text('c', 3, 'C')]);
  relay.dropConnections();
  await vi.waitFor(() => expect(replica.getState().timeline.entries.map(row => row.itemKey)).toEqual(['a', 'b', 'c']), { timeout: 8000, interval: 20 });
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'), { timeout: 3000, interval: 10 });
  expect(relay.requests.map(request => request.direction)).toEqual(['after']);
  expect(relay.requests[0]).toMatchObject({ epoch: 'epoch-one', seq: 2 });
});

it('confirms a message awaiting its echo across a replacement that keeps its anchor row, and marks it unconfirmed when the anchor was rewritten', async () => {
  const kept = await openSession({ rows: [text('a', 1, 'A'), text('b', 2, 'B')] });
  await kept.client.sendMessage('Ship it');
  expect(kept.replica.getState().outgoingMessages).toMatchObject([{ afterKey: 'b', status: 'awaiting_echo' }]);
  kept.relay.replace([text('a', 1, 'A'), text('b', 2, 'B'), text('echo', 3, 'Ship it', 'user')], 'epoch-two');
  await vi.waitFor(() => expect(kept.replica.getState().timeline.epoch).toBe('epoch-two'));
  await vi.waitFor(() => expect(kept.replica.getState().outgoingMessages).toEqual([]));

  const rewritten = await openSession({ rows: [text('a', 1, 'A'), text('b', 2, 'B')] });
  await rewritten.client.sendMessage('Ship it');
  rewritten.relay.replace([text('a', 1, 'A'), text('echo', 2, 'Ship it', 'user')], 'epoch-two');
  await vi.waitFor(() => expect(rewritten.replica.getState().timeline.epoch).toBe('epoch-two'));
  await vi.waitFor(() => expect(rewritten.replica.getState().outgoingMessages).toMatchObject([{ status: 'unconfirmed' }]));
});

it('ends in the last epoch rows when replacements follow each other and when one arrives during the catch-up', async () => {
  const { relay, replica } = await openSession({ rows: [text('a', 1, 'A'), text('b', 2, 'B')] });
  const release = relay.holdTails();
  relay.replace([text('a', 1, 'A'), text('x', 2, 'X')], 'epoch-two');
  await vi.waitFor(() => expect(replica.getState().timeline.pendingEpoch).toBe('epoch-two'));
  relay.replace([text('a', 1, 'A'), text('y', 2, 'Y'), text('z', 3, 'Z')], 'epoch-three');
  await vi.waitFor(() => expect(replica.getState().timeline.pendingEpoch).toBe('epoch-three'));
  release();
  await vi.waitFor(() => expect(replica.getState().timeline.epoch).toBe('epoch-three'), { timeout: 3000 });
  expect(replica.getState().timeline.entries.map(row => row.itemKey)).toEqual(['a', 'y', 'z']);
  expect(replica.getState().timeline.pendingEpoch).toBeUndefined();
  expect(replica.getState().retiredEpochs).toEqual(expect.arrayContaining(['epoch-one', 'epoch-two']));
});

it('keys rows by item key on a flagged stream, and by the older key on a stream that does not echo the flag', async () => {
  const flagged = await openSession({ rows: [text('a', 1, 'A')] });
  const keyedContainer = await render(<Screen replica={flagged.replica} />);
  expect([...nodesByKey(keyedContainer).keys()]).toEqual(['a']);
  const plain = await openSession({ echoFlag: false, rows: [text('a', 1, 'A')] });
  const plainContainer = await render(<Screen replica={plain.replica} />);
  expect([...nodesByKey(plainContainer).keys()]).toEqual(['copilot:1:a']);
  plain.relay.replace([text('a', 1, 'A'), text('b', 2, 'B')], 'epoch-two');
  await vi.waitFor(() => expect(plain.replica.getState().timeline.epoch).toBe('epoch-two'));
  expect(plain.replica.getState().timeline.entries).toHaveLength(2);
});
