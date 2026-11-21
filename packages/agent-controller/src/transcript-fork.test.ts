import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI that forks a transcript two writers use (`fork_on_divergence`, as Claude Code declares), played by the CLI
 * simulator through the managed stdio directory, as Claude Code is registered. A page's turn and a terminal's turn that end within the 2,000 ms
 * divergence tolerance fork the transcript: native history shows the terminal's branch, and the page must come to show what native history
 * shows. Open item O49 (section 10 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`; requirements review gap 1).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

async function residentSession() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const cli = simulatedCli({ behaviour: claudeBehaviour, sessions: { 'thread-1': ['Base', 'Base reply'] }, turnMs: 1000 });
  const runtime = createAgentHostRuntime({ registrations: [cli.stdioRegistration()] });
  closers.push(() => runtime.close());
  const attached = await runtime.control({ requestId: 'open', method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });
  expect(attached.status).toBe(200);
  /** The texts of the session's timeline as the Controller holds it, which its journal and its pages follow. */
  const shown = async () => {
    const lease = await runtime.acquireSession('agent-1');
    try { return lease!.agent.fetchTimeline({ requestId: 'read', agentId: 'agent-1', direction: 'tail', limit: 100 }).payload.entries.map(entry => 'text' in entry.item ? entry.item.text : ''); }
    finally { lease?.release(); }
  };
  return { cli, runtime, shown };
}

describe('a transcript two writers fork', () => {
  it('shows what native history shows when the terminal wrote more than the tolerance after the page', async () => {
    const { cli, runtime, shown } = await residentSession();
    const lease = await runtime.acquireSession('agent-1');
    await lease!.agent.sendMessage('PAGE');
    lease!.release();
    await vi.advanceTimersByTimeAsync(2500);
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(['Base', 'Base reply', 'PAGE', 'Reply to PAGE', 'TERM', 'Reply to TERM']);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await shown()).toEqual(['Base', 'Base reply', 'PAGE', 'Reply to PAGE', 'TERM', 'Reply to TERM']);
  });

  it.fails("shows the terminal's branch, which native history shows, when both turns end within the tolerance (O49)", async () => {
    const { cli, runtime, shown } = await residentSession();
    const lease = await runtime.acquireSession('agent-1');
    await lease!.agent.sendMessage('PAGE');
    lease!.release();
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(['Base', 'Base reply', 'TERM', 'Reply to TERM']);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await shown()).toEqual(['Base', 'Base reply', 'TERM', 'Reply to TERM']);
  });
});
