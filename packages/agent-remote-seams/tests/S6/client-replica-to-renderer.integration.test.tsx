// @vitest-environment jsdom
import { act, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentReplica, remoteSessionState, selectTimeline } from '@orchardworks/agent-client';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { buildEntry, buildReplica, buildSnapshot, buildRestoredReplica, buildTailPage, buildTailRows, replicaAfter } from '@orchardworks/agent-client/testing';
import { AgentComposer, AgentTimeline } from '@orchardworks/agent-client-web';

/**
 * S6, client replica to renderer (docs/current/agent-remote/seams.md). The real replica and the real timeline view, driven by frames and no connection: the view reads
 * the replica's state only, keeps rows keyed by item key, and an unchanged row keeps its DOM node across a confirmation or a replacement.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => { for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); } });

function Screen({ replica }: { replica: AgentReplica }) {
  const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
  return <AgentTimeline state={state} />;
}
async function show(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}
const nodesByKey = (container: HTMLElement) => new Map(Array.from(container.querySelectorAll<HTMLElement>('.agent-timeline-entry')).map(node => [node.dataset.entryKey!, node]));
const textOf = (container: HTMLElement) => container.textContent ?? '';

describe('S6 client replica to renderer', () => {
  it('paints the rows of a restored replica by item key before any frame arrives', async () => {
    const container = await show(<Screen replica={buildRestoredReplica({ rows: 3 })} />);
    expect([...nodesByKey(container).keys()]).toEqual(['m1', 'm2', 'm3']);
    expect(textOf(container)).toContain('row 2');
  });

  it('keeps every unchanged row mounted when the first server tail confirms a restored window', async () => {
    const replica = buildRestoredReplica({ rows: 3 });
    const container = await show(<Screen replica={replica} />);
    const before = nodesByKey(container);
    await act(async () => { replica.applyHistory(buildTailPage(buildTailRows(3), { epoch: 'e1' })); });
    const after = nodesByKey(container);
    expect([...after.keys()]).toEqual(['m1', 'm2', 'm3']);
    for (const key of after.keys()) expect(after.get(key)).toBe(before.get(key));
  });

  it('keeps unchanged rows mounted through a replacement in a new epoch, and never shows an empty timeline between', async () => {
    const replica = buildReplica({ rows: 3 });
    const container = await show(<Screen replica={replica} />);
    const before = nodesByKey(container);
    const sizes: number[] = [];
    replica.subscribe(() => sizes.push(replica.getState().timeline.entries.length));
    await act(async () => { replica.replaceTimeline('e2'); });
    expect(nodesByKey(container).size).toBe(3);
    await act(async () => { replica.applyHistory(buildTailPage([buildEntry(1), buildEntry(2, 'row 2 changed'), buildEntry(3), buildEntry(4, 'new')], { epoch: 'e2' })); });
    const after = nodesByKey(container);
    expect([...after.keys()]).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(after.get('m1')).toBe(before.get('m1'));
    expect(after.get('m3')).toBe(before.get('m3'));
    expect(textOf(after.get('m2')!)).toContain('row 2 changed');
    expect(sizes.every(size => size > 0)).toBe(true);
  });

  it('keeps earlier rows mounted when a live row arrives', async () => {
    const replica = buildReplica({ rows: 2 });
    const container = await show(<Screen replica={replica} />);
    const before = nodesByKey(container);
    await act(async () => { replica.applyHistory(buildTailPage([...buildTailRows(2), buildEntry(3)], { epoch: 'e1' })); });
    const after = nodesByKey(container);
    expect([...after.keys()]).toEqual(['m1', 'm2', 'm3']);
    expect(after.get('m1')).toBe(before.get('m1'));
  });

  it('gives the same timeline object when a page repeats what the replica holds', () => {
    const replica = replicaAfter([buildTailPage(buildTailRows(2), { epoch: 'e1' })]);
    const first = selectTimeline(replica.getState()).entries;
    replica.applyHistory(buildTailPage(buildTailRows(2), { epoch: 'e1' }));
    const second = selectTimeline(replica.getState()).entries;
    first.forEach((entry, at) => expect(second[at]!.item).toBe(entry.item));
  });

  it('shows what the reader sent in the words of the send state: sending, then sent and waiting, and nothing once the echo arrives', async () => {
    const replica = buildReplica({ rows: 1 });
    replica.applySnapshot({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: buildSnapshot() });
    const container = await show(<Screen replica={replica} />);
    let id = '';
    await act(async () => { id = replica.beginMessage('agent-1', 'Ship it'); });
    expect(textOf(container)).toContain('Ship it');
    expect(textOf(container)).toContain('Sending');
    await act(async () => replica.acknowledgeMessage(id));
    expect(textOf(container)).toMatch(/Sent|waiting/);
    expect(container.querySelector('[data-delivery-state]')).not.toBeNull();
  });

  it('offers a failed message its retry and an echo that never came its words, from the replica state alone', async () => {
    const replica = buildReplica({ rows: 1 });
    replica.applySnapshot({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: buildSnapshot() });
    const container = await show(<Screen replica={replica} />);
    let id = '';
    await act(async () => { id = replica.beginMessage('agent-1', 'Try again'); replica.updateMessage(id, 'failed', 'The Host refused it.'); });
    expect(container.querySelector('[data-delivery-state="failed"]')).not.toBeNull();
    await act(async () => replica.deleteMessage(id));
    expect(container.querySelector('[data-delivery-state]')).toBeNull();
  });

  it('takes a send over a restored replica, shows it as Sending, and sends it only after the first server page confirms the state', async () => {
    const replica = buildRestoredReplica({ rows: 2 });
    const sent: string[] = [];
    function Composer() {
      const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
      // The client turns ready once a server page confirmed the restored window.
      const session = remoteSessionState(state, state.timeline.restoredFromDevice ? 'catching_up' : 'ready');
      return <AgentComposer state={state} sessionState={session} draft="Typed early" onSendMessage={async text => { sent.push(text); }} />;
    }
    const container = await show(<Composer />);
    const submit = () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Sending');
    expect(sent).toEqual([]);
    await act(async () => { replica.applyHistory(buildTailPage(buildTailRows(2), { epoch: 'e1' })); });
    await act(async () => {});
    expect(sent).toEqual(['Typed early']);
  });
});
