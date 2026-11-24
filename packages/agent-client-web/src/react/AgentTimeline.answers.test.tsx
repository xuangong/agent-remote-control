// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createReplicaState, type AgentReplicaState } from '@orchardworks/agent-client';
import { TimelineRows } from '@orchardworks/agent-client/testing';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TaskDirectoryContext, type AskLine, type TaskDirectory } from './TaskDirectory.js';

/** Two ended turns of work and answers, and a running third, as a replica holds them. */
function conversation(running = false): AgentReplicaState {
  const rows = new TimelineRows('claude', Date.parse('2026-11-20T10:00:00Z'));
  rows.user('Write notes.md', { key: 'p1', turnId: 't1' });
  rows.tool('Read', { type: 'read', filePath: '/w/README.md' }, 'completed', { key: 'read-1', turnId: 't1' });
  rows.tool('Write', { type: 'write', filePath: '/w/notes.md' }, 'completed', { key: 'write-1', turnId: 't1' });
  rows.assistant('Wrote it.', { key: 'a1', turnId: 't1' });
  rows.assistant('Anything else?', { key: 'a1b', turnId: 't1' });
  rows.user('Run the tests', { key: 'p2', turnId: 't2' });
  rows.tool('Bash', { type: 'shell', command: 'npm test' }, running ? 'running' : 'completed', { key: 'test-2', turnId: 't2',
    ...(running ? {} : { result: { content: [{ type: 'text' as const, text: 'all green' }], exitCode: 0 } }) });
  if (!running) rows.assistant('All green.', { key: 'a2', turnId: 't2' });
  const base = createReplicaState();
  return { ...base, agent: { id: 'agent', providerId: 'claude', createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z',
    status: running ? 'running' : 'idle', activeTurn: running ? { turnId: 't2', startedAt: '2026-11-20T10:00:06Z' } : null, pendingInteractions: [],
    capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
    runtimeInfo: { providerId: 'claude', sessionId: 'native', status: running ? 'running' : 'idle' } },
  timeline: { ...base.timeline, epoch: 'e', initialized: true, entries: rows.entries, nextSeq: rows.entries.length + 1 } };
}


const directory = (asks: readonly AskLine[], seen: Array<{ providerId: string; nativeSessionId: string }> = []): TaskDirectory => ({ canOpen: () => false, open: () => {}, owned: () => [], act: async () => {},
  asks: from => { seen.push(from); return asks; } });
const startOf = (state: AgentReplicaState, prompt: string) => Date.parse(state.timeline.entries.find(entry => entry.item.type === 'user_message' && entry.item.text === prompt)!.timestamp);
/** The asks and the conversation's rows in page order, each named by its id or its words. */
const pageOrder = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-ask-id], .agent-timeline-entry')].map(node => node.dataset.askId ?? node.textContent ?? '');
const answerLines = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-ask-id]')];

it('shows what the person asked a bot from this conversation as one line that opens to the question and the answer, after the turn it came during', async () => {
  const state = conversation();
  const seen: Array<{ providerId: string; nativeSessionId: string }> = [];
  const asks: AskLine[] = [
    { id: 'one', botId: 'b_1', bot: 'Reviewer', text: 'Is **notes.md** fine?', at: startOf(state, 'Write notes.md') + 1, answer: { text: 'Yes, ship it.', at: startOf(state, 'Write notes.md') + 2 } },
    { id: 'two', botId: 'b_2', bot: 'Tracker', text: 'What is open?', at: startOf(state, 'Run the tests') + 1 },
  ];
  const container = await render(<TaskDirectoryContext.Provider value={directory(asks, seen)}><AgentTimeline state={state} processMode="concise" /></TaskDirectoryContext.Provider>);
  expect(seen[0]).toEqual({ providerId: 'claude', nativeSessionId: 'native' });
  const lines = answerLines(container);
  expect(lines.map(line => line.querySelector('summary')!.textContent)).toEqual(['Reviewer answered', 'Tracker is answering']);
  expect(lines[0]!.hasAttribute('data-answered')).toBe(true);
  expect(lines[0]!.textContent).toContain('Is **notes.md** fine?');
  expect(lines[0]!.textContent).toContain('Yes, ship it.');
  expect(lines[1]!.hasAttribute('data-answered')).toBe(false);
  // The first line follows the first turn and the second the second: the order of the page is the order of the asks.
  const order = pageOrder(container), at = (words: string) => order.findIndex(item => item.includes(words));
  expect(order.indexOf('one')).toBeGreaterThan(at('Anything else?'));
  expect(order.indexOf('one')).toBeLessThan(at('Run the tests'));
  expect(order.indexOf('two')).toBeGreaterThan(at('All green.'));
  expect(container.querySelector('.agent-timeline-empty')).toBeNull();
});

it('shows an ask that came before the first turn first, and an ask of a conversation with no turns yet by itself', async () => {
  const state = conversation();
  const early: AskLine = { id: 'early', botId: 'b_1', bot: 'Reviewer', text: 'Before anything?', at: startOf(state, 'Write notes.md') - 1000 };
  const first = await render(<TaskDirectoryContext.Provider value={directory([early])}><AgentTimeline state={state} processMode="concise" /></TaskDirectoryContext.Provider>);
  expect(pageOrder(first)[0]).toBe('early');
  const empty = await render(<TaskDirectoryContext.Provider value={directory([early])}><AgentTimeline state={{ ...state, timeline: { ...state.timeline, entries: [] } }} processMode="concise" /></TaskDirectoryContext.Provider>);
  expect(answerLines(empty).map(line => line.dataset.askId)).toEqual(['early']);
});

it('shows no line when the page offers no asks, or the conversation has none', async () => {
  const bare = await render(<AgentTimeline state={conversation()} processMode="concise" />);
  expect(answerLines(bare)).toEqual([]);
  const none = await render(<TaskDirectoryContext.Provider value={directory([])}><AgentTimeline state={conversation()} processMode="concise" /></TaskDirectoryContext.Provider>);
  expect(answerLines(none)).toEqual([]);
});
