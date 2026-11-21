import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import type { AgentProviderBehaviour, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { TURN_SILENCE_MS } from './session-core/turn-watchdog.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI that stops answering in the middle of a turn, played by the CLI simulator (`hang`, S7): the turn shows its
 * user message and nothing more. For an adapter that declares no heartbeat the Controller's watchdog ends the turn and releases the
 * runtime, so the page does not say Working for ever and the next send reaches a fresh attachment. Requirements review gap 4.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

async function hungTurn(behaviour: AgentProviderBehaviour) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const cli = simulatedCli({ behaviour, sessions: { 'thread-1': ['Hello', 'Hi'] }, turnMs: 1000 });
  const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
  closers.push(async () => { await runtime.close(); });
  const attached = await runtime.control({ requestId: 'open', method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });
  expect(attached.status).toBe(200);
  const lease = await runtime.acquireSession('agent-1');
  const events: AgentStreamEvent[] = [];
  lease!.agent.subscribe(event => { if (event.type === 'agent_stream') events.push(event.event); });
  cli.faults.hang();
  await lease!.agent.sendMessage('Stuck');
  lease!.release();
  return { cli, runtime, events };
}

describe('a turn whose CLI stops answering', () => {
  it('ends native_unresponsive after 15 minutes of silence, releases the runtime, and the next send attaches the session again (gap 4)', async () => {
    const { cli, runtime, events } = await hungTurn(codexBehaviour('shared'));
    await vi.advanceTimersByTimeAsync(TURN_SILENCE_MS - 1);
    expect(events.map(event => event.type)).not.toContain('turn_failed');
    await vi.advanceTimersByTimeAsync(1);
    expect(events.find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_unresponsive' });
    await vi.advanceTimersByTimeAsync(0);
    expect(cli.native('thread-1').clients).toBe(0);
    const next = await runtime.acquireSession('agent-1');
    await next!.agent.sendMessage('Again');
    next!.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cli.native('thread-1')).toMatchObject({ clients: 1, resumes: 2, history: ['Hello', 'Hi', 'Stuck', 'Again', 'Reply to Again'] });
  });

  it('is left to the adapter that declares a heartbeat of its own', async () => {
    const { cli, events } = await hungTurn({ ...codexBehaviour('shared'), turn: { heartbeatMs: 45_000 } });
    await vi.advanceTimersByTimeAsync(2 * TURN_SILENCE_MS);
    expect(events.map(event => event.type)).not.toContain('turn_failed');
    expect(cli.native('thread-1').clients).toBe(1);
  });
});
