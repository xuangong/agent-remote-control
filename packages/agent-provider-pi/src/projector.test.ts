import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { PiProjector, type PiEntry, type Projected } from './projector.js';
import { FakeClock, playRun, sessionLines, type RunScript } from './test-utils/fake-pi.js';
import { parsePiSession, activeBranch } from './session-file.js';

const RUN: RunScript = { prompt: 'Run the tests', messages: [
  { thinking: 'I should look first', text: 'Looking.', tools: [{ id: 'call_1', name: 'bash', args: { command: 'ls' }, output: 'a.txt\n', exitCode: 0 }] },
  { text: 'There is one file.' },
] };

const history = (script: RunScript): Projected[] => {
  const { messages } = playRun(script, new FakeClock());
  const content = parsePiSession(sessionLines('0f5c51e2-71e4-4ab9-b111-e054c951bc6a', '/work', messages).join('\n'))!;
  return new PiProjector('/work').history(activeBranch(content.entries) as PiEntry[]);
};
const live = (script: RunScript): Projected[] => {
  const projector = new PiProjector('/work');
  return playRun(script, new FakeClock()).events.flatMap(event => projector.live(event));
};
const types = (rows: Projected[]) => rows.map(({ event }) => event.type === 'timeline' ? event.item.type : event.type);
const finalItems = (rows: Projected[]) => {
  const items = new Map<string, { type: string; completes: boolean; liveOnly: boolean }>();
  for (const { event, identity } of rows) if (event.type === 'timeline' && identity) items.set(identity.key, { type: event.item.type, completes: items.get(identity.key)?.completes === true || identity.completes === true, liveOnly: identity.liveOnly === true });
  return [...items.entries()];
};

describe('PiProjector', () => {
  it('reads a run from the session file: the user message and its turn, then every block in order, then the end of the turn', () => {
    const rows = history(RUN);
    expect(types(rows)).toEqual(['user_message', 'turn_started', 'reasoning', 'assistant_message', 'tool_call', 'assistant_message', 'turn_completed']);
    const turnIds = new Set(rows.map(({ event }) => 'turnId' in event ? event.turnId : undefined));
    expect(turnIds.size).toBe(1);
    const tool = rows.find(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call')!.event as Extract<AgentStreamEvent, { type: 'timeline' }>;
    expect(tool.item).toMatchObject({ type: 'tool_call', callId: 'call_1', name: 'bash', status: 'completed', detail: { type: 'shell', command: 'ls' }, result: { content: [{ type: 'text', text: 'a.txt\n', stream: 'combined' }] } });
  });

  it('shows the same items, by the same keys and finished the same way, when the run is live and when its file is read again', () => {
    expect(finalItems(live(RUN))).toEqual(finalItems(history(RUN)));
    expect(finalItems(history(RUN)).every(([, item]) => item.completes)).toBe(true);
  });

  it('streams text as append-only deltas and completes the item with what the stream lacked', () => {
    const rows = live({ prompt: 'hi', messages: [{ text: 'hello there' }] }).filter(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message');
    const texts = rows.map(({ event }) => event.type === 'timeline' && event.item.type === 'assistant_message' ? event.item.text : '');
    expect(texts).toEqual(['hello ', 'there', '']);
    expect(rows.map(({ identity }) => identity?.completes === true)).toEqual([false, false, true]);
  });

  it('opens the turn with the user message of the run, and ends it from the stop reason of its last answer', () => {
    expect(types(live({ prompt: 'hi', messages: [{ text: 'ok' }] }))).toEqual(['user_message', 'turn_started', 'assistant_message', 'assistant_message', 'assistant_message', 'turn_completed']);
    const failed = live({ prompt: 'hi', messages: [{ stopReason: 'error', errorMessage: '429 rate limit' }] });
    expect(failed.map(({ event }) => event.type)).toContain('turn_failed');
    expect(failed.find(({ event }) => event.type === 'timeline' && event.item.type === 'error')?.identity).toMatchObject({ completes: true });
    expect(history({ prompt: 'hi', messages: [{ stopReason: 'error', errorMessage: '429 rate limit' }] }).map(({ event }) => event.type)).toContain('turn_failed');
    expect(live({ prompt: 'hi', messages: [{ text: 'partial', stopReason: 'aborted' }] }).map(({ event }) => event.type)).toContain('turn_canceled');
  });

  it('keeps a user message inside the run when it was steering, and starts a new turn for the next prompt', () => {
    const clock = new FakeClock();
    const first = playRun({ prompt: 'one', messages: [{ tools: [{ id: 'c', name: 'bash', args: { command: 'x' }, output: 'y' }] }] }, clock);
    const steer = { role: 'user', content: [{ type: 'text', text: 'steer' }], timestamp: clock.next() };
    const after = playRun({ messages: [{ text: 'done' }] }, clock).messages;
    const second = playRun({ prompt: 'two', messages: [{ text: 'again' }] }, clock).messages;
    const messages = [...first.messages.slice(0, 3), steer, ...after, ...second];
    const content = parsePiSession(sessionLines('0f5c51e2-71e4-4ab9-b111-e054c951bc6a', '/work', messages).join('\n'))!;
    const rows = new PiProjector('/work').history(activeBranch(content.entries) as PiEntry[]);
    expect(types(rows).filter(type => type === 'turn_started')).toHaveLength(2);
    const users = rows.filter(({ event }) => event.type === 'timeline' && event.item.type === 'user_message');
    expect(users.map(({ event }) => 'turnId' in event ? event.turnId : '')[0]).toBe(users.map(({ event }) => 'turnId' in event ? event.turnId : '')[1]);
  });

  it('ends a tool that never got its result as canceled in the history of an interrupted run', () => {
    const { messages } = playRun({ prompt: 'x', messages: [{ tools: [{ id: 'call_9', name: 'bash', args: { command: 'sleep 9' }, output: '' }] }] }, new FakeClock());
    const content = parsePiSession(sessionLines('0f5c51e2-71e4-4ab9-b111-e054c951bc6a', '/work', messages.slice(0, 2)).join('\n'))!;
    const rows = new PiProjector('/work').history(activeBranch(content.entries) as PiEntry[]);
    expect(rows.find(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call')?.event).toMatchObject({ item: { status: 'canceled' } });
    expect(rows.at(-1)?.event.type).toBe('turn_canceled');
  });

  it('shows a tool the model called and pi blocked as failed, with the reason pi gave', () => {
    const rows = live({ prompt: 'x', messages: [{ tools: [{ id: 'c', name: 'bash', args: { command: 'rm -rf x' }, output: 'The user denied this tool call.', isError: true }] }, { text: 'ok' }] });
    expect(rows.find(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'failed')?.event).toMatchObject({ item: { error: 'The user denied this tool call.' } });
  });

  it('turns resource references the Host wrote into a prompt back into resource parts', () => {
    const text = `see <agent-resource>${JSON.stringify({ locator: 'input-resource:abc', path: '/tmp/a.txt', name: 'a.txt', mediaType: 'text/plain', byteLength: 3, sha256: 'a'.repeat(64), label: 'a.txt' })}</agent-resource>`;
    const row = live({ prompt: text, messages: [{ text: 'ok' }] }).find(({ event }) => event.type === 'timeline' && event.item.type === 'user_message')!.event as Extract<AgentStreamEvent, { type: 'timeline' }>;
    expect(row.item).toMatchObject({ type: 'user_message', text: 'see [a.txt]', content: [{ type: 'text', text: 'see ' }, { type: 'resource', name: 'a.txt' }] });
  });

  it('records a compaction once, under the same key live and in the file', () => {
    const projector = new PiProjector('/work');
    const rows = projector.live({ type: 'compaction_end', reason: 'manual', result: { summary: 's', firstKeptEntryId: 'abc12345', tokensBefore: 9000 }, aborted: false, willRetry: false });
    const file = new PiProjector('/work').history([{ type: 'compaction', id: 'x', parentId: null, timestamp: '2026-11-26T00:00:00.000Z', summary: 's', firstKeptEntryId: 'abc12345', tokensBefore: 9000 }]);
    expect(rows[0]?.identity).toEqual(file[0]?.identity);
    expect(rows[0]?.event).toMatchObject({ item: { type: 'compaction', status: 'completed', trigger: 'manual', preTokens: 9000 } });
  });
});
