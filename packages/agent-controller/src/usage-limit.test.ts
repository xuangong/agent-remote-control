import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import type { AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI that signals its account's usage limit on a turn, as real CLIs do, played by the CLI simulator: the turn fails
 * typed `native_usage_limited`, and the session reports when the limit resets until a turn runs again, so a page can say when and hold its
 * sends until then. Requirements review gap 3.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const HOUR = 60 * 60_000;

describe('a usage limit the CLI signals on a turn', () => {
  it('fails the turn typed native_usage_limited, and the session says when the limit resets until a turn runs again (gap 3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    const cli = simulatedCli({ behaviour: claudeBehaviour, sessions: { 'thread-1': ['Hello', 'Hi'] }, turnMs: 1000 });
    const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
    closers.push(() => runtime.close());
    const attached = await runtime.control({ requestId: 'open', method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });
    expect(attached.status).toBe(200);
    const resetsAt = Date.now() + HOUR;
    cli.faults.usageLimit({ resetsAt, at: 'turn' });
    const lease = await runtime.acquireSession('agent-1');
    const events: AgentStreamEvent[] = [];
    lease!.agent.subscribe(event => { if (event.type === 'agent_stream') events.push(event.event); });
    await lease!.agent.sendMessage('Over the limit');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_usage_limited' });
    expect(lease!.agent.snapshot().payload.runtimeInfo.usageLimit).toEqual({ resetsAt });
    await vi.advanceTimersByTimeAsync(HOUR);
    await lease!.agent.sendMessage('After the reset');
    await vi.advanceTimersByTimeAsync(1000);
    lease!.release();
    expect(lease!.agent.snapshot().payload.runtimeInfo.usageLimit).toBeUndefined();
    expect(cli.native('thread-1').history).toEqual(['Hello', 'Hi', 'Over the limit', 'After the reset', 'Reply to After the reset']);
  });
});
