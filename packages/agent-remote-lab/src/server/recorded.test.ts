import { describe, expect, it } from 'vitest';

import { createRecordedLabProvider } from './recorded.js';

describe('recorded Lab Provider', () => {
  it('removes a disposed session from fixture controls', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'disposed-session' });

    await session.dispose();

    expect(() => controller.advance('disposed-session')).toThrow(
      'Recorded Lab session was not found: disposed-session',
    );
  });

  it('rejects a second live session with the same identity', async () => {
    const { provider } = createRecordedLabProvider();
    const first = await provider.createSession({ sessionId: 'duplicate-session' });

    const attempt = await provider.createSession({ sessionId: 'duplicate-session' }).then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
    if ('session' in attempt) await attempt.session.dispose();

    expect(attempt).toMatchObject({
      error: expect.objectContaining({
        message: 'Recorded Lab session already exists: duplicate-session',
      }),
    });
    await first.dispose();
  });

  it('can advertise a deterministic restricted capability Snapshot', async () => {
    const { provider } = createRecordedLabProvider({ capabilities: { steer: false } });
    const session = await provider.createSession({ sessionId: 'restricted-capabilities' });

    expect(session.capabilities.steer).toBe(false);
    expect(session.capabilities.sendMessage).toBe(true);
    await session.dispose();

    const { provider: defaultProvider } = createRecordedLabProvider();
    const defaultSession = await defaultProvider.createSession({ sessionId: 'default-capabilities' });
    expect(defaultSession.capabilities.steer).toBe(true);
    await defaultSession.dispose();
  });

  it('defers a steer observation behind an explicit release and cancels pending fixture waits on cleanup', async () => {
    const { provider, controller } = createRecordedLabProvider({ deferSteerObservation: true });
    const session = await provider.createSession({ sessionId: 'gated-steer' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'history_boundary') {}

    await session.steer?.('released direction');
    await controller.waitForDeferredSteer('gated-steer');
    let observationSettled = false;
    const observation = iterator.next().then((value) => {
      observationSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(observationSettled).toBe(false);

    controller.releaseDeferredSteer('gated-steer');
    await expect(observation).resolves.toMatchObject({
      done: false,
      value: {
        type: 'observation',
        event: { type: 'timeline', item: { type: 'reasoning', text: 'Steered: released direction' } },
      },
    });

    const pendingWait = controller.waitForDeferredSteer('gated-steer');
    await session.dispose();
    await expect(pendingWait).rejects.toThrow('Recorded Lab session is closed.');
  });

  it('exposes bounded history separately from live observations and preserves persistence identity', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'recorded-session' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    const history = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error('Recorded stream ended before its history boundary.');
      if (next.value.type === 'history_boundary') break;
      history.push(next.value);
    }

    expect(history).toHaveLength(6);
    expect(history.every(({ delivery }) => delivery === 'history')).toBe(true);
    expect((await session.runtimeInfo()).persistence).toEqual({
      providerId: 'recorded',
      sessionId: 'recorded-session',
      opaque: 'recorded:recorded-session',
    });

    controller.advance('recorded-session');
    const liveTypes = [];
    while (liveTypes.length < 8) {
      const next = await iterator.next();
      if (next.done || next.value.type !== 'observation') continue;
      liveTypes.push(next.value.event.type === 'timeline' ? next.value.event.item.type : next.value.event.type);
    }
    expect(liveTypes).toEqual([
      'turn_started', 'assistant_message', 'reasoning', 'tool_call',
      'tool_call', 'todo', 'turn_completed', 'interaction_requested',
    ]);
    await session.dispose();
  });

  it('chains all three closed interaction forms using only advertised actions', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'interactions' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'history_boundary') {}
    controller.advance('interactions');
    await nextRequest(iterator, 'question');

    await session.respondToInteraction('recorded-question', {
      kind: 'question', answers: [{ questionId: 'release', selectedValues: ['stable'] }],
    });
    await nextRequest(iterator, 'plan_approval');
    await session.respondToInteraction('recorded-plan', { kind: 'plan_approval', action: 'approve' });
    const allow = await nextRequest(iterator, 'tool_approval');
    if (allow.kind !== 'tool_approval') throw new Error('Expected a tool approval request.');
    expect(allow.allowScopes).toEqual(['once']);
    await session.respondToInteraction('recorded-tool-once', { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    const deny = await nextRequest(iterator, 'tool_approval');
    if (deny.kind !== 'tool_approval') throw new Error('Expected a tool approval request.');
    expect(deny.allowedDecisions).toEqual(['deny']);
    await session.respondToInteraction('recorded-tool-deny', { kind: 'tool_approval', decision: 'deny' });
    await session.dispose();
  });

  it('serves safe resource bytes until the reader is stopped and reports unsupported locators', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'resources' });

    await expect(session.readResource?.('artifacts/lab-proof.txt')).resolves.toEqual({
      status: 'available',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('BORgee Agent Remote durable resource\n'),
    });
    await expect(session.readResource?.('artifacts/missing.txt')).resolves.toEqual({
      status: 'unavailable', reason: 'Recorded resource is unavailable.',
    });
    await expect(session.readResource?.('artifacts/failed.txt')).rejects.toThrow('Recorded resource acquisition failed.');
    controller.stopResourceReader('resources');
    await expect(session.readResource?.('artifacts/lab-proof.txt')).resolves.toEqual({
      status: 'unavailable', reason: 'Recorded Provider resource reader is stopped.',
    });
    await session.dispose();
  });

  it('can expose a deterministic failed Agent state after readiness', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'failed-state' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'history_boundary') {}

    controller.fail('failed-state');

    const next = await iterator.next();
    expect(next).toMatchObject({
      done: false,
      value: {
        type: 'observation',
        event: { type: 'turn_failed', code: 'recorded_failure' },
      },
    });
    await session.dispose();
  });

  it('publishes the durable resource again in an authoritative rehydrated Timeline', async () => {
    const { provider, controller } = createRecordedLabProvider();
    const session = await provider.createSession({ sessionId: 'rehydrated-resources' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'history_boundary') {}

    controller.rehydrate('rehydrated-resources');

    const next = await iterator.next();
    expect(next.done).toBe(false);
    if (next.done || next.value.type !== 'observation' || next.value.event.type !== 'timeline') {
      throw new Error('Expected the rehydrated Timeline observation.');
    }
    expect(next.value.event.item).toMatchObject({
      type: 'assistant_message',
      text: expect.stringContaining('[lab-proof.txt](artifacts/lab-proof.txt)'),
    });
    await session.dispose();
  });
});

async function nextRequest(
  iterator: AsyncIterator<import('@borgee/agent-provider-sdk').ProviderStreamItem>,
  kind: import('@borgee/agent-provider-sdk').AgentInteractionRequest['kind'],
) {
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error(`Recorded stream ended before ${kind}.`);
    if (next.value.type === 'observation' && next.value.event.type === 'interaction_requested'
      && next.value.event.request.kind === kind) return next.value.event.request;
  }
}
