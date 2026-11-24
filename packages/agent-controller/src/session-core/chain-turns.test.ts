import type { ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { assistantMessageText, joinTaskInputs, nativeSessionRefKey, standingInstructionsText } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { boundary, ScriptedSession } from '../test-utils/journal-scripted-session.js';
import { BotTools } from '../bot-tools.js';
import { inputCause, TurnCauses, watchChainTurns, type PersonInput, type TurnReport } from './chain-turns.js';

let sequence = 0;
const event = (value: ProviderObservation['event'], delivery: 'live' | 'history' = 'live'): ProviderObservation => ({ type: 'observation', sourceKey: `fake:${++sequence}`, occurredAt: 0, delivery, event: value });
const input = (text: string, messageId?: string, delivery?: 'live' | 'history') => event({ type: 'timeline', provider: 'fake', item: { type: 'user_message', text, ...(messageId ? { messageId } : {}) } }, delivery);
const completed = (usage?: { tokenScope: 'turn' | 'session'; totalTokens: number; totalCostUsd?: number }) => event({ type: 'turn_completed', provider: 'fake', turnId: 't', ...(usage ? { usage } : {}) });
const ref = { controllerId: 'mac', providerId: 'fake', nativeSessionId: 'native' };

function watched() {
  const session = new ScriptedSession('fake', 'native', [boundary()]);
  const causes = new TurnCauses(), turns: TurnReport[] = [], items: ProviderStreamItem[] = [], written: PersonInput[] = [];
  void (async () => { for await (const item of watchChainTurns(session, ref, causes, turn => turns.push(turn), input => written.push(input)).observe()) items.push(item); })();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { session, causes, turns, items, written, settle };
}

describe('the causes and usage of a bot\'s turns', () => {
  it('names the person\'s input by its message, framed input as the Relay\'s, and passes every item on', async () => {
    const { session, causes, items, settle } = watched();
    session.push(input('Plan the release.', 'u1'));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'person', messageId: 'u1' });
    session.push(input(assistantMessageText({ messageId: 'm0123456789ab', from: 'Tracker', body: 'Green.' })));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
    // Old history replayed on attachment starts no turn.
    session.push(input('An old request.', 'u0', 'history'));
    await settle();
    expect(causes.of(ref)).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
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

const said = (text: string, messageId?: string) => event({ type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text, ...(messageId ? { messageId } : {}) } });
const tool = () => event({ type: 'timeline', provider: 'fake', item: { type: 'tool_call', callId: 'c', name: 'shell', detail: { type: 'unknown', input: null, output: null }, status: 'completed', error: null } as never });
const message = (messageId: string, replyTo?: string, final?: boolean) => assistantMessageText({ messageId, from: 'Tracker', ...(replyTo ? { replyTo } : {}), ...(final ? { final } : {}), body: 'Is it cut?' });

describe('which message a turn answers', () => {
  it('names the one message from another bot that started the turn, unless it is a reply or shares the turn with another input', () => {
    expect(inputCause({ text: message('m0123456789ab') })).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
    // Standing instructions are not messages.
    expect(inputCause({ text: joinTaskInputs([standingInstructionsText('Review.'), message('m0123456789ab')]) })).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
    // A message sent as a reply (a review request after the receiver's question) is a request like any other and earns its answer.
    expect(inputCause({ text: message('m0123456789ab', 'm0000000000aa') })).toEqual({ kind: 'framed', answers: 'm0123456789ab' });
    // The final answer of a turn ends the exchange, and several messages are answered one by one with reply_to.
    expect(inputCause({ text: message('m0123456789ab', 'm0000000000aa', true) })).toEqual({ kind: 'framed' });
    expect(inputCause({ text: joinTaskInputs([message('m0123456789ab'), message('m0123456789ac')]) })).toEqual({ kind: 'framed' });
    expect(inputCause({ text: standingInstructionsText('Review.') })).toEqual({ kind: 'framed' });
    expect(inputCause({ text: 'Please look.', messageId: 'u1' })).toEqual({ kind: 'person', messageId: 'u1' });
  });
});

describe('the final text of a turn', () => {
  it('is the last run of the bot\'s own text, reported with the ended turn and not carried into the next', async () => {
    const { session, turns, settle } = watched();
    session.push(input(message('m0123456789ab')));
    session.push(said('Let me check. ', 'a1'));
    session.push(tool());
    session.push(said('Yes, ', 'a2'));
    session.push(said('cut at noon.', 'a2'));
    session.push(completed({ tokenScope: 'turn', totalTokens: 5 }));
    session.push(input('Thanks.', 'u2'));
    session.push(completed({ tokenScope: 'turn', totalTokens: 3 }));
    await settle();
    expect(turns).toEqual([{ cause: { kind: 'framed', answers: 'm0123456789ab' }, tokens: 5, finalText: 'Yes, cut at noon.' }, { cause: { kind: 'person', messageId: 'u2' }, tokens: 3 }]);
  });

  it('is the text of the turn the person steered to, so the turn answers nothing', async () => {
    const { session, turns, settle } = watched();
    session.push(input(message('m0123456789ab')));
    session.push(said('Working.'));
    session.push(input('Also the notes.', 'u1'));
    session.push(said('Done.'));
    session.push(completed({ tokenScope: 'turn', totalTokens: 5 }));
    await settle();
    expect(turns).toEqual([{ cause: { kind: 'person', messageId: 'u1' }, tokens: 5, finalText: 'Done.' }]);
  });
});

describe('what the person types into the session', () => {
  it('is reported with its message id, and neither input the Relay framed nor replayed history is', async () => {
    const { session, written, settle } = watched();
    session.push(input('  Skip the flaky test.  ', 'u1'));
    session.push(input(message('m0123456789ab')));
    session.push(input('An old request.', 'u0', 'history'));
    await settle();
    expect(written).toEqual([{ messageId: 'u1', text: 'Skip the flaky test.' }]);
  });
});

describe('standing approvals of a chain (bots plan 9d)', () => {
  const request = (requestId: string, toolName = 'Edit') => ({ kind: 'tool_approval' as const, requestId, toolCallId: `call-${requestId}`, toolName, summary: toolName, detail: { type: 'other' as const, description: toolName },
    allowedDecisions: ['allow' as const, 'deny' as const], allowScopes: ['once' as const] });
  const requested = (value: ReturnType<typeof request>) => event({ type: 'interaction_requested', provider: 'fake', request: value });
  const runtime = (cwd: string) => event({ type: 'runtime_updated', provider: 'fake', runtimeInfo: { providerId: 'fake', sessionId: 'native', status: 'idle', cwd, persistence: { providerId: 'fake', sessionId: 'native', opaque: '{}' } } });
  const chainChoice = (value: { policies?: Array<{ policyId: string }> } | undefined) => value?.policies?.some(policy => policy.policyId === 'chain-folder') === true;

  /** The Relay's side of it as the Host sees it: standing approvals by chain (the person's message) and folder, and the requests it was asked about. */
  function setup(options: { bot?: boolean } = {}) {
    const standing = new Set<string>(), asked: string[] = [], answered: Array<{ requestId: string; response: unknown }> = [];
    const causes = new TurnCauses();
    const tools = new BotTools({ tasks: () => true, answer: async (_ref, requestId, response) => { answered.push({ requestId, response }); },
      request: async call => {
        if (call.action !== 'chain_approval') return {};
        const key = `${call.cause?.kind === 'person' ? call.cause.messageId : 'framed'}|${call.cwd}`;
        asked.push(key);
        if (call.grant) { standing.add(key); return { chain: key }; }
        return { allowed: standing.has(key) };
      } });
    if (options.bot !== false) (tools as unknown as { bots: Map<string, unknown> }).bots.set(nativeSessionRefKey(ref), { mission: '', memory: [] });
    const session = new ScriptedSession('fake', 'native', [boundary()]), responses: unknown[] = [], items: ProviderStreamItem[] = [];
    session.respondToInteraction = async (_id, response) => { responses.push(response); };
    const watching = watchChainTurns(session, ref, tools.causes, () => {}, () => {}, tools.approvalsFor(ref));
    void (async () => { for await (const item of watching.observe()) items.push(item); })();
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const pending = (requestId: string) => items.map(item => item.type === 'observation' && item.event.type === 'interaction_requested' ? item.event.request : undefined).find(value => value?.requestId === requestId);
    void causes;
    return { session, watching, standing, asked, answered, responses, items, settle, pending };
  }

  it('offers "for this chain in this folder" on a bot\'s tool approval, records the choice when the person makes it, and the adapter hears allow once', async () => {
    const f = setup();
    f.session.push(runtime('/repo')); f.session.push(input('Fix it.', 'u1')); f.session.push(requested(request('r1')));
    await f.settle();
    const shown = f.pending('r1') as { allowScopes: string[]; policies: Array<{ policyId: string }> };
    expect(chainChoice(shown)).toBe(true);
    expect(shown.allowScopes).toContain('policy');
    await f.watching.respondToInteraction('r1', { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'chain-folder' });
    expect([...f.standing]).toEqual(['u1|/repo']);
    expect(f.responses).toEqual([{ kind: 'tool_approval', decision: 'allow', scope: 'once' }]);
    // The person's other answers pass through untouched.
    await f.watching.respondToInteraction('r1', { kind: 'tool_approval', decision: 'deny' });
    expect(f.responses.at(-1)).toEqual({ kind: 'tool_approval', decision: 'deny' });
  });

  it('answers allow, like the person, the next tool approval of any kind in the same folder of the same chain', async () => {
    const f = setup();
    f.standing.add('u1|/repo');
    f.session.push(runtime('/repo')); f.session.push(input('Fix it.', 'u1')); f.session.push(requested(request('r1')));
    await f.settle();
    f.session.push(requested(request('r2', 'Bash')));
    await f.settle();
    expect(f.answered).toEqual(['r1', 'r2'].map(requestId => ({ requestId, response: { kind: 'tool_approval', decision: 'allow', scope: 'once' } })));
  });

  it('asks the person for another folder, another chain and a revoked approval', async () => {
    const f = setup();
    f.standing.add('u1|/repo');
    f.session.push(runtime('/other')); f.session.push(input('Fix it.', 'u1')); f.session.push(requested(request('folder', 'Bash')));
    f.session.push(runtime('/repo')); f.session.push(input('Another thing.', 'u2')); f.session.push(requested(request('chain')));
    f.session.push(input('Back.', 'u1')); f.standing.delete('u1|/repo'); f.session.push(requested(request('revoked')));
    await f.settle();
    expect(f.answered).toEqual([]);
    expect(f.asked).toEqual(['u1|/other', 'u2|/repo', 'u1|/repo']);
  });

  it('offers nothing on a session that is no bot\'s, and on an approval that cannot be allowed once', async () => {
    const plain = setup({ bot: false });
    plain.session.push(runtime('/repo')); plain.session.push(input('Fix it.', 'u1')); plain.session.push(requested(request('r1')));
    await plain.settle();
    expect(chainChoice(plain.pending('r1'))).toBe(false);
    expect(plain.asked).toEqual([]);
    const sessionOnly = setup();
    sessionOnly.session.push(runtime('/repo')); sessionOnly.session.push(input('Fix it.', 'u1')); sessionOnly.session.push(requested({ ...request('r2'), allowScopes: ['session'] as never }));
    await sessionOnly.settle();
    expect(chainChoice(sessionOnly.pending('r2'))).toBe(false);
  });
});
