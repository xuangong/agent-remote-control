// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConformanceFixture,
  expectConverged,
  sharedEvents,
  type ConformanceBrowser,
  type ConformanceFixture,
} from '../test/relay-conformance.js';

const manifestPath = process.env.BORGEE_REMOTE_CONFORMANCE_MANIFEST;

describe.skipIf(!manifestPath)('Go Relay public protocol conformance against Node', () => {
  let fixture: ConformanceFixture | undefined;

  beforeEach(async () => { fixture = await createConformanceFixture(manifestPath!); });
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it('preserves the directory, creation identity, independent Snapshot, and Timeline pages', async () => {
    const f = fixture!;
    const [baselineProviders, targetProviders] = await Promise.all([
      f.baselineTransport.listProviders(), f.targetTransport.listProviders(),
    ]);
    expect(targetProviders).toEqual(baselineProviders);
    expect(targetProviders).toEqual([{ providerId: 'dsh', displayName: 'Recorded semantic Provider' }]);
    expect(await f.createAgent()).toMatchObject({
      type: 'agent_session',
      payload: { agentId: f.manifest.agentId, sessionId: f.manifest.sessionId, providerId: 'dsh' },
    });
    const snapshot = await f.compareSnapshot();
    expect(snapshot.payload).toMatchObject({ status: 'idle', pendingInteractions: [], model: 'recorded-model' });
    expect(snapshot.payload).not.toHaveProperty('timeline');
    const tail = await f.comparePage('tail');
    expect(tail.payload.entries).toHaveLength(3);
    expect(tail.payload.hasOlder).toBe(true);
    const older = await f.comparePage('before', tail.payload.startCursor!);
    expect(older.payload.entries.map(({ item }) => item.type)).toEqual(['user_message', 'assistant_message', 'reasoning']);
    expect(older.payload.hasOlder).toBe(false);
    const after = await f.comparePage('after', older.payload.endCursor!);
    expect(after.payload.entries).toEqual(tail.payload.entries);
    expect(after.payload.hasNewer).toBe(false);
  });

  it('preserves ordered live messages and control acknowledgements across both transports', async () => {
    const { f, baseline, target } = await openPair(fixture!);
    const baselineStart = baseline.observations.length;
    const targetStart = target.observations.length;
    const text = 'One command through Go.\nA second line with **Markdown**.';
    expect(await target.client.sendMessage(text)).toMatchObject({
      type: 'command_acknowledged', payload: { agentId: f.manifest.agentId, command: 'send_message', requestId: 'target-2' },
    });
    await vi.waitFor(() => expect(messageTexts(target)).toContain(`Recorded reply: ${text}`));
    await target.client.steer('Keep the exact public sequence.');
    await f.controller.waitForDeferredSteer(f.manifest.sessionId);
    f.controller.releaseDeferredSteer(f.manifest.sessionId);
    expect(await target.client.cancel()).toMatchObject({ type: 'command_acknowledged', payload: { command: 'cancel' } });
    await vi.waitFor(() => expect(messageTexts(target)).toContain('Steered: Keep the exact public sequence.'));
    await vi.waitFor(() => expect(sharedEvents(target, targetStart)
      .filter((event) => event.type === 'agent_stream')
      .map((event) => event.payload.event.type)).toEqual(['timeline', 'timeline', 'timeline', 'turn_canceled']));
    await expectConverged(baseline, target);
    await vi.waitFor(() => expect(sharedEvents(target, targetStart)).toEqual(sharedEvents(baseline, baselineStart)));
    expect(messageTexts(target).filter((value) => value === text)).toHaveLength(1);
    await f.compareSnapshot();
    await f.comparePage('tail', undefined, 100);
  });

  it('resolves questions and plans once while every browser observes the same interaction order', async () => {
    const { f, baseline, target } = await openPair(fixture!);
    const baselineStart = baseline.observations.length;
    const targetStart = target.observations.length;
    f.controller.advance(f.manifest.sessionId);
    await vi.waitFor(() => expect(target.replica.getState().pendingInteractions.map(({ kind }) => kind)).toEqual(['question']));
    const question = { kind: 'question', answers: [{ questionId: 'release', selectedValues: ['stable'] }] } as const;
    await target.client.respondToInteraction('recorded-question', {
      ...question, answers: question.answers.map((answer) => ({ ...answer, selectedValues: [...answer.selectedValues] })),
    });
    await vi.waitFor(() => expect(target.replica.getState().pendingInteractions.map(({ kind }) => kind)).toEqual(['plan_approval']));
    await target.client.respondToInteraction('recorded-plan', { kind: 'plan_approval', action: 'approve' });
    await vi.waitFor(() => expect(target.replica.getState().pendingInteractions.map(({ requestId }) => requestId)).toEqual(['recorded-tool-once']));
    await target.client.respondToInteraction('recorded-tool-once', { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await vi.waitFor(() => expect(target.replica.getState().pendingInteractions.map(({ requestId }) => requestId)).toEqual(['recorded-tool-deny']));
    await target.client.respondToInteraction('recorded-tool-deny', { kind: 'tool_approval', decision: 'deny' });
    await vi.waitFor(() => expect(messageTexts(target)).toContain('All recorded interactions resolved.'));
    await expectConverged(baseline, target);
    await vi.waitFor(() => expect(sharedEvents(target, targetStart)).toEqual(sharedEvents(baseline, baselineStart)));
    const interactions = target.replica.getState().timeline.entries.filter(({ item }) => item.type === 'interaction');
    expect(interactions.map(({ item }) => item.type === 'interaction' && item.request.requestId)).toEqual([
      'recorded-question', 'recorded-plan', 'recorded-tool-once', 'recorded-tool-deny',
    ]);
    expect(target.replica.getState().pendingInteractions).toEqual([]);
    await f.compareSnapshot();
  });

  it('preserves resource bindings and bytes through Timeline replacement and reader shutdown', async () => {
    const { f, baseline, target } = await openPair(fixture!);
    const id = await availableResource(target);
    const [baselineBytes, targetBytes] = await Promise.all([
      baseline.client.requestResource(id), target.client.requestResource(id),
    ]);
    expect(targetBytes.payload.state).toEqual(baselineBytes.payload.state);
    expect(targetBytes.payload).toMatchObject({ agentId: f.manifest.agentId, resourceId: id });
    expect(targetBytes.payload.state.status).toBe('available');
    if (targetBytes.payload.state.status !== 'available') throw new Error('Recorded resource did not settle.');
    expect(Buffer.from(targetBytes.payload.state.contentBase64, 'base64').toString('utf8')).toBe('BORgee Agent Remote durable resource\n');

    const previousEpoch = target.replica.getState().timeline.epoch;
    f.relay.requireAgent(f.manifest.agentId).replaceTimeline('recorded-conformance-replacement');
    f.controller.rehydrate(f.manifest.sessionId);
    await vi.waitFor(() => expect(target.replica.getState().timeline.epoch).toBe('recorded-conformance-replacement'));
    await vi.waitFor(() => expect(messageTexts(target)).toEqual([
      'Authoritative rehydrated Timeline. Download [lab-proof.txt](artifacts/lab-proof.txt).',
    ]));
    expect(target.replica.getState().retiredEpochs).toContain(previousEpoch);
    await expectConverged(baseline, target);
    expect(await availableResource(target)).toBe(id);
    f.controller.stopResourceReader(f.manifest.sessionId);
    const fresh = f.connect('target', 'reloaded');
    await fresh.ready();
    const reread = await fresh.client.requestResource(id);
    expect(reread.payload.state).toEqual(targetBytes.payload.state);
    await f.comparePage('tail');
  });

  it('recovers multiple after pages on browser reconnect without duplicate messages', async () => {
    const { f, baseline, target } = await openPair(fixture!);
    const writer = f.connect('baseline', 'continuous-writer');
    await writer.ready();
    await writer.allHistory();
    const originalEpoch = target.replica.getState().timeline.epoch;
    baseline.disconnect();
    target.disconnect();
    await Promise.all([baseline.disconnected(), target.disconnected()]);
    const catchupStart = target.observations.length;
    for (let index = 0; index < 4; index += 1) {
      await writer.client.sendMessage(`While disconnected ${index}`);
    }
    await vi.waitFor(() => expect(messageTexts(writer)).toContain('Recorded reply: While disconnected 3'));
    await Promise.all([baseline.reconnect(), target.reconnect()]);
    await expectConverged(baseline, target);
    expect(target.replica.getState()).toEqual(baseline.replica.getState());
    expect(target.replica.getState().timeline.entries).toEqual(writer.replica.getState().timeline.entries);
    expect(target.replica.getState().timeline.epoch).toBe(originalEpoch);
    const pages = target.observations.slice(catchupStart).filter((entry) => entry.channel === 'http'
      && entry.message.type === 'timeline_page' && entry.message.payload.direction === 'after');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < 4; index += 1) {
      expect(messageTexts(target).filter((text) => text === `While disconnected ${index}`)).toHaveLength(1);
    }
    await f.compareSnapshot();
    await f.comparePage('tail', undefined, 100);
  });

  it('isolates browser operations and retains one session across uplink recovery without replaying a command', async () => {
    const { f, baseline, target } = await openPair(fixture!);
    const continuous = f.connect('baseline', 'continuous-observer');
    await continuous.ready();
    await continuous.allHistory();
    const other = f.connect('target', 'other-browser');
    await other.ready();
    await other.allHistory();
    const id = await availableResource(other);
    const before = await f.compareSnapshot();
    const epoch = target.replica.getState().timeline.epoch;
    const releaseAcknowledgement = f.holdSteerAcknowledgement();
    const operation = target.client.steer('Accepted exactly once across uplink recovery.');
    const disconnected = expect(operation).rejects.toMatchObject({ code: 'connection_disconnected' });
    await f.controller.waitForDeferredSteer(f.manifest.sessionId);

    // A separate browser's resource request must finish while this command waits.
    expect(await other.client.requestResource(id)).toMatchObject({
      type: 'resource_response', payload: { requestId: 'other-browser-2', resourceId: id, state: { status: 'available' } },
    });
    expect(target.observations.some(({ direction, message }) => direction === 'inbound'
      && message.type === 'resource_response' && message.payload.requestId === 'other-browser-2')).toBe(false);

    baseline.disconnect();
    await f.disconnectUplink();
    await disconnected;
    await Promise.all([baseline.disconnected(), target.disconnected(), other.disconnected()]);
    releaseAcknowledgement();
    f.controller.releaseDeferredSteer(f.manifest.sessionId);
    await vi.waitFor(() => expect(messageTexts(continuous)).toContain('Steered: Accepted exactly once across uplink recovery.'));
    await f.reconnectUplink();
    await Promise.all([baseline.reconnect(), target.reconnect(), other.reconnect()]);
    await expectConverged(baseline, target);
    await expectConverged(baseline, other);
    expect(target.replica.getState()).toEqual(baseline.replica.getState());
    expect(target.replica.getState().timeline.entries).toEqual(continuous.replica.getState().timeline.entries);
    const after = await f.compareSnapshot();
    expect(after.payload.createdAt).toBe(before.payload.createdAt);
    expect(after.payload.persistence).toEqual(before.payload.persistence);
    expect(target.replica.getState().timeline.epoch).toBe(epoch);
    expect(messageTexts(target).filter((text) => text === 'Steered: Accepted exactly once across uplink recovery.')).toHaveLength(1);
    expect(target.observations.filter(({ direction, message }) => direction === 'outbound' && message.type === 'steer')).toHaveLength(1);
    expect(await target.client.sendMessage('Still the same session.')).toMatchObject({ type: 'command_acknowledged' });
    await vi.waitFor(() => expect(messageTexts(target)).toContain('Recorded reply: Still the same session.'));
    await expectConverged(baseline, target);
  });
});

async function openPair(f: ConformanceFixture) {
  await f.createAgent();
  const baseline = f.connect('baseline');
  const target = f.connect('target');
  await Promise.all([baseline.ready(), target.ready()]);
  await Promise.all([baseline.allHistory(), target.allHistory()]);
  await expectConverged(baseline, target);
  return { f, baseline, target };
}

function messageTexts(browser: ConformanceBrowser): string[] {
  return browser.replica.getState().timeline.entries.flatMap(({ item }) => 'text' in item ? [item.text] : []);
}

async function availableResource(browser: ConformanceBrowser): Promise<string> {
  let resourceId: string | undefined;
  await vi.waitFor(() => {
    const binding = browser.replica.getState().timeline.entries.flatMap(({ resources }) => resources)
      .find(({ locator }) => locator === 'artifacts/lab-proof.txt');
    expect(binding?.status).toBe('available');
    resourceId = binding?.resourceId;
  }, { timeout: 5_000 });
  return resourceId!;
}
