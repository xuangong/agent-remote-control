import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it, vi } from 'vitest';

import { boundary, ScriptedSession } from '../test-utils/journal-scripted-session.js';
import { watchExit } from './native-exit.js';

let sequence = 0;
const failed = (code?: string): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery: 'live',
  event: { type: 'turn_failed', provider: 'fake', turnId: 'turn-1', error: 'The CLI exited.', ...(code ? { code } : {}) } });

/** A watched scripted session, what its reader received, and whether the stream it read ended. */
function watched() {
  const session = new ScriptedSession('fake', 'native', [boundary()]);
  const exited = vi.fn();
  const items: ProviderStreamItem[] = [];
  const watchedSession = watchExit(session, { exited });
  const reading = (async () => { for await (const item of watchedSession.observe()) items.push(item); })().catch(() => undefined);
  return { session, watchedSession, exited, items, reading };
}
const settle = () => new Promise<void>(resolve => { setImmediate(resolve); });

describe('the exit of a native CLI', () => {
  it('releases the runtime once a turn failed native_exited has reached the reader, with the CLI\'s reason (X1, X3)', async () => {
    const { session, exited, items } = watched();
    session.push(failed('native_exited'));
    await settle();
    expect(items.at(-1)).toMatchObject({ event: { type: 'turn_failed', code: 'native_exited', error: 'The CLI exited.' } });
    expect(exited).toHaveBeenCalledOnce();
    await session.dispose();
    await settle();
    expect(exited).toHaveBeenCalledOnce();
  });

  it('takes a stream that ends without a dispose for an exit, and a failure of another code for none (X2)', async () => {
    const { session, exited } = watched();
    session.push(failed('native_usage_limited'));
    await settle();
    expect(exited).not.toHaveBeenCalled();
    await session.dispose();
    await settle();
    expect(exited).toHaveBeenCalledOnce();
  });

  it('releases nothing when the Controller disposes the session (X3)', async () => {
    const { watchedSession, exited, reading } = watched();
    await settle();
    await watchedSession.dispose();
    await reading;
    expect(exited).not.toHaveBeenCalled();
  });
});
