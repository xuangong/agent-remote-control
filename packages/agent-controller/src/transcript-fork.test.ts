import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI that forks a transcript two writers use (`fork_on_divergence`, as Claude Code declares), played by the CLI
 * simulator through the managed stdio directory, as Claude Code is registered. Whatever the timing of a page's turn and a terminal's turn,
 * the page comes to show what native history shows: the content of the transcript decides divergence, not the time between the writes
 * (O49 in section 10 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`; requirements review gap 1).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const BASE = ['Base', 'Base reply'];
const PAGE = [...BASE, 'PAGE', 'Reply to PAGE'];
const TERMINAL_BRANCH = [...BASE, 'TERM', 'Reply to TERM'];

async function residentSession() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const cli = simulatedCli({ behaviour: claudeBehaviour, sessions: { 'thread-1': BASE }, turnMs: 1000 });
  const runtime = createAgentHostRuntime({ registrations: [cli.stdioRegistration()] });
  closers.push(() => runtime.close());
  const attached = await runtime.control({ requestId: 'open', method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });
  expect(attached.status).toBe(200);
  /** The texts of the session's timeline as the Controller holds it, which its journal and its pages follow; acquiring it checks divergence, as a send does. */
  const shown = async () => {
    const lease = await runtime.acquireSession('agent-1');
    try { return lease!.agent.fetchTimeline({ requestId: 'read', agentId: 'agent-1', direction: 'tail', limit: 100 }).payload.entries.map(entry => 'text' in entry.item ? entry.item.text : ''); }
    finally { lease?.release(); }
  };
  /** The page's turn: sent through the Controller, ending `turnMs` (1,000 ms) later. */
  const pageTurn = async () => { const lease = await runtime.acquireSession('agent-1'); await lease!.agent.sendMessage('PAGE'); lease!.release(); };
  return { cli, runtime, shown, pageTurn };
}

describe('a transcript two writers fork', () => {
  it('shows what native history shows when the terminal wrote after the page\'s turn ended', async () => {
    const { cli, shown, pageTurn } = await residentSession();
    await pageTurn();
    await vi.advanceTimersByTimeAsync(2500);
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual([...PAGE, 'TERM', 'Reply to TERM']);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await shown()).toEqual([...PAGE, 'TERM', 'Reply to TERM']);
  });

  it.each([0, 1_999, 2_001])("shows the terminal's branch, which native history shows, when the terminal's turn ends %i ms after the page's (O49)", async gapMs => {
    const { cli, shown, pageTurn } = await residentSession();
    await pageTurn();
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1000 + gapMs });
    await vi.advanceTimersByTimeAsync(1000 + gapMs);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(TERMINAL_BRANCH);
    expect(await shown()).toEqual(TERMINAL_BRANCH);
    expect(cli.native('thread-1').resumes).toBe(2);
  });

  it("keeps the page's branch when the page's turn ends last, since native history shows it too, and reads nothing again", async () => {
    const { cli, shown, pageTurn } = await residentSession();
    await pageTurn();
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(PAGE);
    expect(await shown()).toEqual(PAGE);
    expect(cli.native('thread-1').resumes).toBe(1);
  });

  it("brings a page that shows the session to the terminal's branch at the next listing, without a send", async () => {
    const { cli, runtime, shown, pageTurn } = await residentSession();
    runtime.sessionsShown(['simulated:thread-1']);
    await pageTurn();
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await terminal).toBe('written');
    // The page's revision check reads the listing once the terminal has been quiet for 30 s; the session is read again behind it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await runtime.control({ requestId: 'revision', method: 'GET', path: '/remote/catalog/revision?providerId=simulated' })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(100);
    expect(cli.native('thread-1').resumes).toBe(2);
    expect(await shown()).toEqual(TERMINAL_BRANCH);
  });
});
