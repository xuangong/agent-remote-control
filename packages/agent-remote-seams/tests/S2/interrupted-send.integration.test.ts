import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeTime, simulatedStack, until, type Frame } from './support/simulated-stack.js';

/**
 * S2, settling a send whose delivery the page does not know (gap 5): the page asks, with the send's operation, whether it arrived, and the
 * Controller answers through the Relay from native history, which keeps the operation id as the input's client id (`input.identity`
 * `echoes_client_id`, as Codex declares). Nothing is sent to settle it. The CLI is the simulator.
 */
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const ARRIVED = '33333333-3333-4333-8333-333333333333';
const NEVER_SENT = '44444444-4444-4444-8444-444444444444';

describe('S2 settling a send the page does not know arrived', () => {
  it('is acknowledged for a message native history holds, refused as not delivered for one it does not, and sends nothing (gap 5)', async () => {
    fakeTime();
    const stack = await simulatedStack(codexBehaviour('shared'), closers);
    const opened = await stack.attach();
    const page = await stack.openPage(opened.body.agentId);
    await until(() => page.control() !== undefined, 'the control state');
    page.acquire('take');
    await until(() => page.control()?.access === 'control', 'control');
    page.send('Arrived', ARRIVED);
    await until(() => page.liveTexts().includes('Reply to Arrived'), 'the reply');
    const answer = (requestId: string) => page.frames.find((frame: Frame) => frame.payload?.requestId === requestId && (frame.type === 'command_acknowledged' || frame.type === 'protocol_error'));
    page.send('Arrived', ARRIVED, { settle: true });
    page.send('Never sent', NEVER_SENT, { settle: true });
    await until(() => !!answer(`settle-${ARRIVED}`) && !!answer(`settle-${NEVER_SENT}`), 'both answers');
    expect(answer(`settle-${ARRIVED}`)).toMatchObject({ type: 'command_acknowledged', payload: { command: 'send_message' } });
    expect(answer(`settle-${NEVER_SENT}`)).toMatchObject({ type: 'protocol_error', payload: { code: 'input_not_delivered' } });
    expect(stack.cli.native('thread-1').history).toEqual(['Hello', 'Hi', 'Arrived', 'Reply to Arrived']);
  });
});
