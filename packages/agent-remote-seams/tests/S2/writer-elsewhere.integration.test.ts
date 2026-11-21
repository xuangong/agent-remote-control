import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeTime, simulatedStack } from './support/simulated-stack.js';

/**
 * S2, a session whose writer is elsewhere: a process outside the CLI's shared clients writes it, so the CLI refuses the Controller. The CLI
 * is the simulator playing what the Codex adapter declares (a separate `codex exec resume` meets Codex's single writer). The page must stay
 * live, read from the journal, state the CLI's reason and offer a retry, never a take-over that would stop the other process. Open item O48
 * (section 10 of `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`).
 */
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const MINUTE = 60_000;
const daemon = codexBehaviour('shared');

/** A session a page read once, which no page shows now, which the Controller let go and the CLI unloaded; then a separate process writes it. */
async function writtenElsewhere() {
  fakeTime();
  const stack = await simulatedStack(daemon, closers);
  const first = await stack.attach();
  await vi.advanceTimersByTimeAsync(1000);
  const page = await stack.openPage(first.body.agentId);
  await vi.advanceTimersByTimeAsync(1000);
  page.close();
  await vi.advanceTimersByTimeAsync(8 * MINUTE);
  expect(stack.cli.native('thread-1')).toMatchObject({ clients: 0, loaded: false });
  const separate = stack.cli.externalWriter('thread-1', { text: 'SEPARATE', separate: true, turnMs: MINUTE });
  return { ...stack, agentId: first.body.agentId as string, separate };
}

describe('S2 a session written by a process outside the CLI', () => {
  it.fails("stays readable from its journal, says the CLI's reason, offers a retry and no take-over, and goes live again after it (O48)", async () => {
    const { attach, openPage, agentId, separate, cli } = await writtenElsewhere();
    const opened = await attach();
    expect(opened).toMatchObject({ status: 200, body: { agentId } });
    const page = await openPage(agentId);
    page.tail();
    await vi.advanceTimersByTimeAsync(1000);
    const tail = page.frames.find(frame => frame.type === 'timeline_page');
    expect(tail?.payload.entries.map((entry: { item: { text: string } }) => entry.item.text)).toEqual(['Hello', 'Hi']);
    expect(page.frames.find(frame => frame.type === 'agent_snapshot')?.payload.status).toBe('idle');
    expect(page.frames.some(frame => JSON.stringify(frame).includes('writer_elsewhere'))).toBe(true);
    expect(page.frames.some(frame => JSON.stringify(frame).includes('nativeOwner'))).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(await separate).toBe('written');
    expect((await attach()).status).toBe(200);
    await vi.advanceTimersByTimeAsync(2000);
    expect(cli.native('thread-1').clients).toBe(1);
    expect(page.liveTexts()).toContain('Reply to SEPARATE');
  });
});
