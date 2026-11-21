import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeTime, simulatedStack } from './support/simulated-stack.js';

/**
 * S2, residency of a session a page shows: the Relay serves the page from the session's journal, and the session stays live only while
 * the Controller holds it, attached to the CLI. The CLI is the simulator playing what the Codex adapter declares of its shared daemon:
 * another client of the daemon (a terminal through the shared socket) writes turns, and the daemon unloads a thread 70 s after its last
 * client leaves. Open item O47 (section 10 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`).
 */
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const MINUTE = 60_000;
/** How long after its turn ends another client's turn may take to reach a page that shows the session: one event, not a refresh. */
const LIVE_MS = 2000;
/** What "a short grace" allows on top of the CLI's own unload time, after the last page stops showing the session. */
const SHORT_GRACE_MS = 20_000;
const daemon = codexBehaviour('shared');

async function shown() {
  fakeTime();
  const stack = await simulatedStack(daemon, closers);
  const attached = await stack.attach();
  expect(attached.status).toBe(200);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await stack.journalServed()).toBe(true);
  const page = await stack.openPage(attached.body.agentId);
  await vi.advanceTimersByTimeAsync(1000);
  return { ...stack, page };
}

describe('S2 a session a page shows', () => {
  it("shows another client's turn live while the page has just opened it", async () => {
    const { cli, page } = await shown();
    const written = cli.externalWriter('thread-1', { text: 'FROM-TERMINAL' });
    await vi.advanceTimersByTimeAsync(1000 + LIVE_MS);
    expect(await written).toBe('written');
    expect(page.liveTexts()).toContain('Reply to FROM-TERMINAL');
  });

  it("stays resident past the idle grace, so another client's turn still reaches the page live (O47)", async () => {
    const { cli, page } = await shown();
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(cli.native('thread-1').clients).toBe(1);
    const written = cli.externalWriter('thread-1', { text: 'FROM-TERMINAL' });
    await vi.advanceTimersByTimeAsync(1000 + LIVE_MS);
    expect(await written).toBe('written');
    expect(page.liveTexts()).toContain('Reply to FROM-TERMINAL');
  });

  it('is let go a short grace after no page shows it, so the CLI unloads it within its own unload time of the page closing (O47)', async () => {
    const { cli, page } = await shown();
    page.close();
    await vi.advanceTimersByTimeAsync(daemon.concurrency.unloadAfterLastClientMs! + SHORT_GRACE_MS);
    expect(cli.native('thread-1')).toMatchObject({ clients: 0, loaded: false });
  });
});
