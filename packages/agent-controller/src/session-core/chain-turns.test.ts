import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { assistantMessageText } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { boundary, ScriptedSession } from '../test-utils/journal-scripted-session.js';
import { TurnCauses, watchChainTurns, type TurnReport } from './chain-turns.js';

let sequence = 0;
const event = (value: ProviderObservation['event'], delivery: 'live' | 'history' = 'live'): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery, event: value });
const input = (text: string, messageId?: string, delivery?: 'live' | 'history') => event({ type: 'timeline', provider: 'fake', item: { type: 'user_message', text, ...(messageId ? { messageId } : {}) } }, delivery);
const completed = (usage?: { tokenScope: 'turn' | 'session'; totalTokens: number; totalCostUsd?: number }) => event({ type: 'turn_completed', provider: 'fake', turnId: 't', ...(usage ? { usage } : {}) });
const ref = { controllerId: 'mac', providerId: 'fake', nativeSessionId: 'native' };

function watched() {
  const session = new ScriptedSession('fake', 'native', [boundary()]);
  const causes = new TurnCauses(), turns: TurnReport[] = [], items: ProviderStreamItem[] = [];
  void (async () => { for await (const item of watchChainTurns(session, ref, causes, turn => turns.push(turn)).observe()) items.push(item); })();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { session, causes, turns, items, settle };
}

describe('the causes and usage of a bot\'s turns', () => {
  it('names the person\'s input by its message, framed input as the Relay\'s, and passes every item on', async () => {
    const { session, causes, items, settle } = watched();
    session.push(input('Plan the release.', 'u1'));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'person', messageId: 'u1' });
    session.push(input(assistantMessageText({ messageId: 'm0123456789ab', from: 'Tracker', body: 'Green.' })));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'framed' });
    // Old history replayed on attachment starts no turn.
    session.push(input('An old request.', 'u0', 'history'));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'framed' });
    expect(items).toHaveLength(4);
  });

  it('reports each ended turn with its cause and what its usage grew, for turn and session totals alike', async () => {
    const { session, turns, settle } = watched();
    session.push(input('First.', 'u1'));
    session.push(completed({ tokenScope: 'turn', totalTokens: 500, totalCostUsd: 0.01 }));
    session.push(input('Second.', 'u2'));
    session.push(completed({ tokenScope: 'turn', totalTokens: 300 }));
    await settle();
    expect(turns).toEqual([{ cause: { kind: 'person', messageId: 'u1' }, tokens: 500, costUsd: 0.01 }, { cause: { kind: 'person', messageId: 'u2' }, tokens: 300 }]);
    const other = watched();
    other.session.push(input('One.', 'a'));
    other.session.push(completed({ tokenScope: 'session', totalTokens: 1000 }));
    other.session.push(input('Two.', 'b'));
    other.session.push(completed({ tokenScope: 'session', totalTokens: 1400 }));
    await other.settle();
    expect(other.turns.map(turn => turn.tokens)).toEqual([1000, 400]);
  });

  it('reports no turn before any input it saw', async () => {
    const { session, turns, settle } = watched();
    session.push(completed({ tokenScope: 'turn', totalTokens: 10 }));
    await settle();
    expect(turns).toEqual([]);
  });
});
