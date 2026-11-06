import { afterEach, expect, it, vi } from 'vitest';
import { appendSessionExcerpts, appendSessionReferences, createSessionExcerpt, splitSessionExcerpts, splitSessionReferences } from '@orchardworks/agent-remote-protocol';
import { createReplicaState, type AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { LabWorkbenchActions } from './components/LabWorkbench.js';
import { withViewQuotes, restoreQuotes } from './session-quotes.js';
import { changeSessionRef, loadSessionRefs, pendingReferenceNote, withSessionReferences } from './session-references.js';

const scope = 'https://relay.example/u/test/';
const holder = { hostId: 'host', providerId: 'claude', nativeSessionId: 'side' };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function host(responses: unknown[]) {
  const requests: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    requests.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return requests;
}
function state(texts: string[]): AgentReplicaState {
  const initial = createReplicaState();
  return { ...initial, timeline: { ...initial.timeline, initialized: true, entries: texts.map((text, index) => ({ providerId: 'claude', turnId: `turn-${index}`,
    item: { type: 'user_message', text }, resources: [], timestamp: 'now', seqStart: index + 1, seqEnd: index + 1, sourceSeqRanges: [], collapsed: [] })) } } as AgentReplicaState;
}

it('tells the agent about changed references once, after the user\'s text and before quotes', async () => {
  const requests = host([{ revision: 0, refs: [{ providerId: 'claude', nativeSessionId: 'source', title: 'Source', origin: 'source' }] },
    { revision: 1, refs: [{ providerId: 'codex', nativeSessionId: 'other', title: 'Other', origin: 'added' }] }]);
  await loadSessionRefs(scope, holder);
  expect(requests[0]!.url).toBe(`${scope}v1/remote/hosts/host/session/refs?providerId=claude&nativeSessionId=side`);
  // A Side's source alone is what the agent already knows.
  expect(pendingReferenceNote(scope, holder, state([]))).toBeUndefined();
  await changeSessionRef(scope, holder, 'remove', { providerId: 'claude', nativeSessionId: 'source' });
  expect(requests[1]!.body).toEqual({ providerId: 'claude', nativeSessionId: 'side', action: 'remove', target: { providerId: 'claude', nativeSessionId: 'source' } });
  const sent: string[] = [];
  let timeline = state([]);
  const base: LabWorkbenchActions = { sendMessage: async text => { sent.push(text); timeline = state(sent); } } as LabWorkbenchActions;
  restoreQuotes(scope, 'view', [createSessionExcerpt({ id: 'quote', source: { providerId: 'claude', nativeSessionId: 'source', title: 'Source' }, capturedAt: 'now',
    entries: state(['Quoted']).timeline.entries, selected: () => true })]);
  const actions = withSessionReferences(withViewQuotes(base, scope, 'view'), scope, holder, () => timeline);
  await actions.sendMessage!('First');
  const quoted = splitSessionExcerpts(sent[0]!);
  expect(quoted.excerpts).toHaveLength(1);
  expect(splitSessionReferences(quoted.text)).toEqual({ text: 'First', note: { revision: 1, references: [{ address: 'host/codex/other', title: 'Other', origin: 'added' }] } });
  await actions.sendMessage!('Second');
  expect(sent[1]).toBe('Second');
});

it('leaves out a note another page already sent, as the conversation shows', async () => {
  const other = { ...holder, nativeSessionId: 'other-page' };
  host([{ revision: 1, refs: [] }]);
  await loadSessionRefs(scope, other);
  expect(pendingReferenceNote(scope, other, state([]))).toEqual({ revision: 1, references: [] });
  expect(pendingReferenceNote(scope, other, state([appendSessionExcerpts(appendSessionReferences('Earlier', { revision: 1, references: [] }), [])]))).toBeUndefined();
});
