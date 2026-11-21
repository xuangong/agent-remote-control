import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundary, ScriptedSession } from '../test-utils/journal-scripted-session.js';
import { TURN_UNRESPONSIVE_MESSAGE, watchTurns } from './turn-watchdog.js';

afterEach(() => { vi.useRealTimers(); });

const SILENCE_MS = 1000;
let sequence = 0;
const event = (value: ProviderObservation['event']): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery: 'live', event: value });
const started = (turnId: string) => event({ type: 'turn_started', provider: 'fake', turnId });
const delta = (turnId: string) => event({ type: 'timeline', provider: 'fake', turnId, item: { type: 'assistant_message', text: 'More' } });
const runtime = (activeTurnId: string | null) => event({ type: 'runtime_updated', provider: 'fake', activeTurnId,
  runtimeInfo: { providerId: 'fake', sessionId: 'native', status: activeTurnId ? 'running' : 'idle' } });

/** A watched scripted session and what its reader received. */
function watched() {
  vi.useFakeTimers();
  const session = new ScriptedSession('fake', 'native', [boundary()]);
  const unresponsive = vi.fn();
  const items: ProviderStreamItem[] = [];
  void (async () => { for await (const item of watchTurns(session, { silenceMs: SILENCE_MS, unresponsive }).observe()) items.push(item); })();
  const kinds = () => items.flatMap(item => item.type === 'observation' ? [item.event.type] : []);
  return { session, unresponsive, items, kinds };
}

describe('the turn watchdog', () => {
  it('ends a turn silent for the bound as native_unresponsive, once, with the session idle, and asks for its release (W2)', async () => {
    const { session, unresponsive, items, kinds } = watched();
    session.push(runtime('turn-1'));
    session.push(started('turn-1'));
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    expect(kinds()).toEqual(['runtime_updated', 'turn_started']);
    await vi.advanceTimersByTimeAsync(1);
    expect(kinds()).toEqual(['runtime_updated', 'turn_started', 'turn_failed', 'runtime_updated']);
    const [failed, idle] = items.slice(-2).map(item => item.type === 'observation' ? item.event : undefined);
    expect(failed).toEqual({ type: 'turn_failed', provider: 'fake', turnId: 'turn-1', error: TURN_UNRESPONSIVE_MESSAGE, code: 'native_unresponsive' });
    expect(idle).toMatchObject({ type: 'runtime_updated', activeTurnId: null, runtimeInfo: { status: 'idle' } });
    expect(unresponsive).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10 * SILENCE_MS);
    expect(unresponsive).toHaveBeenCalledOnce();
  });

  it('starts the watch over with every item of the turn, and stops it when the turn ends (W1)', async () => {
    const { session, unresponsive, kinds } = watched();
    session.push(started('turn-1'));
    for (let step = 0; step < 5; step += 1) { await vi.advanceTimersByTimeAsync(SILENCE_MS - 1); session.push(delta('turn-1')); }
    session.push(event({ type: 'turn_completed', provider: 'fake', turnId: 'turn-1' }));
    await vi.advanceTimersByTimeAsync(10 * SILENCE_MS);
    expect(unresponsive).not.toHaveBeenCalled();
    expect(kinds()).not.toContain('turn_failed');
  });

  it('watches a turn a runtime state names, and nothing while no turn runs (W1)', async () => {
    const idle = watched();
    idle.session.push(runtime(null));
    await vi.advanceTimersByTimeAsync(10 * SILENCE_MS);
    expect(idle.unresponsive).not.toHaveBeenCalled();
    idle.session.push(runtime('turn-2'));
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(idle.items.at(-2)).toMatchObject({ event: { type: 'turn_failed', turnId: 'turn-2' } });
  });

  it('passes the CLI\'s items through after it fired, until the session ends', async () => {
    const { session, kinds } = watched();
    session.push(started('turn-1'));
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    session.push(delta('turn-1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds().at(-1)).toBe('timeline');
  });
});
