import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * A send the Controller stopped under, played by the CLI simulator: the first Controller made the native call and stopped before the
 * acknowledgement could reach the page, so the page does not know whether the message arrived. After the restart, a CLI that keeps client
 * ids (`input.identity` `echoes_client_id`, as Codex and Claude Code declare) settles it by a reread of native history, as delivered or not
 * delivered, and the message is never sent again. Requirements review gap 5 (M2 rounds 8 and 10).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const ARRIVED = '11111111-1111-4111-8111-111111111111';
const NEVER_SENT = '22222222-2222-4222-8222-222222222222';

async function controller(cli: ReturnType<typeof simulatedCli>) {
  const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
  const attached = await runtime.control({ requestId: 'open', method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });
  expect(attached.status).toBe(200);
  return runtime;
}

/** The first Controller takes a send and stops before its acknowledgement; the second reads the session again. */
async function restartedUnderSend(behaviour: AgentProviderBehaviour) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const cli = simulatedCli({ behaviour, sessions: { 'thread-1': ['Hello', 'Hi'] }, turnMs: 1000 });
  const first = await controller(cli);
  const lease = await first.acquireSession('agent-1');
  await lease!.agent.sendMessage('Arrived', { inputId: ARRIVED });
  lease!.release();
  await first.close();
  const second = await controller(cli);
  closers.push(() => second.close());
  const again = await second.acquireSession('agent-1');
  closers.push(async () => { again?.release(); });
  return { cli, agent: again!.agent };
}

describe('a send the Controller stopped under', () => {
  it.each([['Codex through its daemon', codexBehaviour('shared')], ['Claude Code', claudeBehaviour]] as const)(
    'is settled after the restart by a reread, as delivered when %s took it and not delivered when it never did, and never sent again (gap 5)', async (_name, behaviour) => {
      const { cli, agent } = await restartedUnderSend(behaviour);
      expect(cli.native('thread-1').history).toEqual(['Hello', 'Hi', 'Arrived']);
      expect(await agent.settleInput!(ARRIVED)).toBe('delivered');
      expect(await agent.settleInput!(NEVER_SENT)).toBe('not_delivered');
      expect(cli.native('thread-1').history.filter(text => text === 'Arrived')).toHaveLength(1);
    });

  it('stays unknown while a turn runs that could still record it', async () => {
    const { agent } = await restartedUnderSend(codexBehaviour('shared'));
    await agent.sendMessage('Running');
    expect(await agent.settleInput!(NEVER_SENT)).toBe('unknown');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await agent.settleInput!(NEVER_SENT)).toBe('not_delivered');
  });

  it('stays unknown for a CLI that keeps no client id, which only the person can check', async () => {
    const { cli, agent } = await restartedUnderSend({ ...codexBehaviour('shared'), input: { identity: 'none', whileBusy: 'steer' } });
    expect(cli.native('thread-1').history).toEqual(['Hello', 'Hi', 'Arrived']);
    expect(await agent.settleInput!(ARRIVED)).toBe('unknown');
    expect(await agent.settleInput!(NEVER_SENT)).toBe('unknown');
  });
});
