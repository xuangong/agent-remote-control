import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AgentSnapshot, type HistoryPage, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { TimelineDisplay } from '@orchardworks/agent-remote-web/react';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { replicaState } from '../test/fixtures.js';
import { render } from '../test/setup.js';
import { EarlierConversation, type EarlierTransport } from './EarlierConversation.js';

afterEach(() => { vi.restoreAllMocks(); });

const session = (id: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: id, title: id });
const entry = (seq: number, text: string, type: 'user_message' | 'assistant_message' = 'assistant_message'): ProjectedTimelineEntry => ({
  providerId: 'claude', seqStart: seq, seqEnd: seq, timestamp: '2026-11-12T09:00:00.000Z', turnId: `turn-${seq}`, resources: [], collapsed: [],
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], item: { type, text } } as ProjectedTimelineEntry);
const page = (agentId: string, entries: ProjectedTimelineEntry[], hasOlder: boolean, direction: 'tail' | 'before' = 'tail'): HistoryPage => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page' as const, payload: {
  requestId: `${direction}-${agentId}`, agentId, epoch: `epoch-${agentId}`, direction, reset: false, staleCursor: false, gap: false,
  window: { minSeq: entries[0]?.seqStart ?? 1, maxSeq: entries.at(-1)?.seqEnd ?? 0, nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1 },
  startCursor: null, endCursor: null, entries, hasOlder, hasNewer: false, error: null } }) as HistoryPage;
const snapshot = (agentId: string, nativeSessionId: string): AgentSnapshot => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot' as const,
  payload: { ...replicaState.agent!, id: agentId, providerId: 'claude', status: 'idle' as const,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'claude', sessionId: nativeSessionId } } }) as AgentSnapshot;

function fixture(pages: Record<string, HistoryPage[]>) {
  const attach = vi.fn(async (_providerId: string, nativeSessionId: string) => ({ agentId: `agent-${nativeSessionId}` }));
  const requests: Array<[string, string, unknown]> = [];
  const transport: EarlierTransport = {
    fetchSnapshot: vi.fn(async (agentId: string) => snapshot(agentId, agentId.slice('agent-'.length))),
    fetchTimeline: vi.fn(async (agentId: string, direction: string, cursor?: unknown) => {
      requests.push([agentId, direction, cursor]);
      const next = pages[agentId]?.shift();
      if (!next) throw new Error('No page');
      return next;
    }),
    connect: vi.fn(() => { throw new Error('An earlier session is read without a stream.'); }),
  };
  return { attach, transport, requests, directory: () => ({ attach }) };
}
const view = (node: React.ReactNode) => <TimelineDisplay.Provider value="content">{node}</TimelineDisplay.Provider>;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

it('shows the cached earlier conversation at once, then the fetched one, without a stream or controls', async () => {
  const f = fixture({ 'agent-past': [page('agent-past', [entry(1, 'Plan the release', 'user_message'), entry(2, 'Fetched reply')], false)] });
  const cached: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, epoch: 'cached', entries: [entry(1, 'Cached reply')], hasOlder: false, pendingLive: [] } } as AgentReplicaState;
  let release!: () => void;
  f.attach.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ agentId: 'agent-past' }); }));
  const container = await render(view(<EarlierConversation baseUrl="http://relay/" transport={f.transport} directory={f.directory} sessions={[session('past')]} readCached={() => cached} />));
  expect(container.textContent).toContain('Cached reply');
  await act(async () => release());
  await settle();
  expect(container.textContent).toContain('Fetched reply');
  expect(container.textContent).not.toContain('Cached reply');
  expect(f.transport.connect).not.toHaveBeenCalled();
  expect(f.requests).toEqual([['agent-past', 'tail', undefined]]);
  expect(container.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe('Earlier conversation');
  expect(container.querySelector('textarea, [contenteditable="true"], [role="textbox"]')).toBeNull();
});

it('loads older pages of an earlier session before revealing the session before it', async () => {
  const f = fixture({
    'agent-past': [page('agent-past', [entry(5, 'Later in the past')], true), page('agent-past', [entry(3, 'Earlier in the past')], false, 'before')],
    'agent-older': [page('agent-older', [entry(1, 'The first session')], false)],
  });
  const container = await render(view(<EarlierConversation baseUrl="http://relay/" transport={f.transport} directory={f.directory} sessions={[session('past'), session('older')]} readCached={() => undefined} />));
  await settle();
  expect(container.textContent).toContain('Later in the past');
  expect(container.querySelector('.lab-earlier-reveal')).toBeNull();
  const older = container.querySelector<HTMLButtonElement>('button.agent-load-older')!;
  await act(async () => older.click());
  await settle();
  expect(f.requests[1]).toEqual(['agent-past', 'before', { epoch: 'epoch-agent-past', seq: 5 }]);
  expect(container.textContent).toContain('Earlier in the past');
  const reveal = container.querySelector<HTMLButtonElement>('.lab-earlier-reveal')!;
  expect(reveal.textContent).toBe('Show earlier conversation');
  await act(async () => reveal.click());
  await settle();
  expect(container.textContent).toContain('The first session');
  // The oldest session reads first, the predecessor last, just above the current conversation.
  const text = container.textContent!;
  expect(text.indexOf('The first session')).toBeLessThan(text.indexOf('Earlier in the past'));
  expect(container.querySelector('.lab-earlier-reveal')).toBeNull();
});

it('offers a quiet retry when an earlier session cannot be read', async () => {
  const f = fixture({});
  f.attach.mockRejectedValueOnce(new Error('Host offline'));
  const container = await render(view(<EarlierConversation baseUrl="http://relay/" transport={f.transport} directory={f.directory} sessions={[session('past')]} readCached={() => undefined} />));
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const retry = container.querySelector<HTMLButtonElement>('.lab-earlier-status button')!;
  expect(container.querySelector('.lab-earlier-status')?.textContent).toContain('Earlier conversation is unavailable.');
  f.attach.mockResolvedValueOnce({ agentId: 'agent-past' });
  (f.transport.fetchTimeline as ReturnType<typeof vi.fn>).mockResolvedValueOnce(page('agent-past', [entry(1, 'Back again')], false));
  await act(async () => retry.click());
  await settle();
  expect(container.textContent).toContain('Back again');
});
