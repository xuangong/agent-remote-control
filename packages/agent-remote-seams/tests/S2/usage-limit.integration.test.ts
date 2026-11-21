import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeTime, simulatedStack, until, type Frame } from './support/simulated-stack.js';

/**
 * S2, a usage limit the CLI signals on a turn: the CLI is the simulator playing what the Claude Code adapter declares. The page's send fails
 * typed `native_usage_limited`, and the session's runtime state tells the page when the limit resets, through the Relay's journal-served
 * stream, so the page can say when and hold later sends until then. Requirements review gap 3.
 */
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

describe('S2 a usage limit the CLI signals on a turn', () => {
  it('reaches the page as a typed failed turn and the time the limit resets (gap 3)', async () => {
    fakeTime();
    const stack = await simulatedStack(claudeBehaviour, closers);
    const opened = await stack.attach();
    expect(opened.status).toBe(200);
    const page = await stack.openPage(opened.body.agentId);
    await until(() => page.control() !== undefined, 'the control state');
    page.acquire('take');
    await until(() => page.control()?.access === 'control', 'control');
    const resetsAt = Date.now() + 60 * 60_000;
    stack.cli.faults.usageLimit({ resetsAt, at: 'turn' });
    page.send('Over the limit');
    const failed = () => page.frames.find(frame => frame.type === 'agent_stream' && frame.payload.event?.type === 'turn_failed');
    await until(() => failed() !== undefined, 'the failed turn');
    expect(failed()!.payload.event).toMatchObject({ code: 'native_usage_limited' });
    const limits = () => page.frames.flatMap((frame: Frame) => [frame.payload?.runtimeInfo?.usageLimit, frame.payload?.event?.runtimeInfo?.usageLimit]).filter(Boolean);
    await until(() => limits().length > 0, 'the time the limit resets');
    expect(limits().at(-1)).toEqual({ resetsAt });
    expect(page.frames.filter(frame => frame.type === 'protocol_error')).toEqual([]);
  });
});
