import { describe, expect, it } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { ClaudeEventProjector } from './projector.js';

const envelope = { session_id: 'session', parent_tool_use_id: null };
const user = (uuid: string, content: unknown, extra: object = {}) => ({ ...envelope, type: 'user', uuid, message: { role: 'user', content }, ...extra });
const assistant = (uuid: string, content: unknown[], model = 'claude-sonnet-4-5', id = 'msg-1') => ({ ...envelope, type: 'assistant', uuid, message: { id, model, role: 'assistant', content } });
const stream = (event: unknown) => ({ ...envelope, type: 'stream_event', event });
const toolResult = (uuid: string, toolUseId: string, output: string, extra: object = {}) => user(uuid, [{ type: 'tool_result', tool_use_id: toolUseId, content: output }], extra);

const run = (projector: ClaudeEventProjector, frames: unknown[]) => frames.flatMap(frame => projector.project(frame));
const timeline = (observations: ProviderObservation[]) => observations.filter(({ event }) => event.type === 'timeline');
const keys = (observations: ProviderObservation[]) => [...new Set(timeline(observations).map(({ itemIdentity }) => itemIdentity?.key))];
const item = ({ event }: ProviderObservation) => event.type === 'timeline' ? event.item : undefined;
const text = (observation: ProviderObservation) => (item(observation) as { text?: string }).text;

/** What the live stream shows for a turn: the input, streamed thinking and text, a tool with its result, and a final answer. */
const turn = [
  user('u1', 'Fix it'),
  stream({ type: 'message_start', message: { id: 'msg-1' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think' } }),
  assistant('a1', [{ type: 'thinking', thinking: 'Think' }]),
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Run' } }),
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ning.' } }),
  assistant('a2', [{ type: 'text', text: 'Running.' }]),
  stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
  assistant('a3', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }]),
  toolResult('r1', 'tool-1', '/workspace'),
  stream({ type: 'message_start', message: { id: 'msg-2' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
  assistant('a4', [{ type: 'text', text: 'Done.' }], 'claude-sonnet-4-5', 'msg-2'),
];
/** What the SDK read returns for the same turn: the records alone. */
const records = turn.filter(frame => (frame as { type: string }).type !== 'stream_event');

describe('Claude item identity', () => {
  it('gives every timeline observation a key, equal for the same items live and in history, and never a controller or delta source key', () => {
    const live = run(new ClaudeEventProjector('session', 'live'), turn);
    const history = run(new ClaudeEventProjector('session', 'history'), records);
    expect(timeline(live).every(({ itemIdentity }) => itemIdentity !== undefined && itemIdentity.key.length > 0 && itemIdentity.key.length <= 4096)).toBe(true);
    expect(keys(live)).toEqual(['user:u1', 'reasoning:msg-1:0', 'assistant:msg-1:1', 'tool:tool-1', 'assistant:msg-2:0']);
    expect(keys(history)).toEqual(keys(live));
    expect([...keys(live), ...keys(history)].filter(key => key?.startsWith('controller:') || key?.includes('stream:'))).toEqual([]);
  });

  it('finishes a streamed block with its record: an empty body when the stream was whole, a tool result with the whole row', () => {
    const live = timeline(run(new ClaudeEventProjector('session', 'live'), turn));
    const rows = (key: string) => live.filter(({ itemIdentity }) => itemIdentity?.key === key);
    expect(rows('assistant:msg-1:1').map(row => [text(row), row.itemIdentity?.completes === true])).toEqual([['Run', false], ['ning.', false], ['', true]]);
    expect(rows('reasoning:msg-1:0').map(row => [text(row), row.itemIdentity?.completes === true])).toEqual([['Think', false], ['', true]]);
    expect(rows('tool:tool-1').map(row => [(item(row) as { status: string }).status, row.itemIdentity?.completes === true])).toEqual([['running', false], ['completed', true]]);
    expect(timeline(run(new ClaudeEventProjector('session', 'history'), records)).every(({ itemIdentity }) => itemIdentity?.completes === true || itemIdentity?.key === 'tool:tool-1')).toBe(true);
  });

  it('finishes the text of a record the stream never showed with the whole text, and an empty record with nothing', () => {
    const projector = new ClaudeEventProjector('session', 'history');
    expect(run(projector, [assistant('a1', [{ type: 'text', text: 'Whole' }])]).map(text)).toEqual(['Whole']);
    expect(run(projector, [assistant('a2', [{ type: 'text', text: '' }], 'claude', 'msg-9')])).toEqual([]);
  });

  it('ends a final that does not continue the stream as it streamed, with the corrected text beside it', () => {
    const live = run(new ClaudeEventProjector('session', 'live'), [
      stream({ type: 'message_start', message: { id: 'msg-1' } }), stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abc' } }), assistant('a1', [{ type: 'text', text: 'xyz' }]),
    ]);
    expect(live.map(row => [row.itemIdentity?.key, text(row), row.itemIdentity?.completes === true])).toEqual([
      ['assistant:msg-1:0', 'abc', false], ['assistant:msg-1:0', '', true], ['assistant:msg-1:0:correction', 'xyz', true],
    ]);
    expect(new Set(live.map(({ sourceKey }) => sourceKey)).size).toBe(live.length);
  });

  it('keys a user row by its uuid, equal live and in history, for input folded into a turn and for an interrupt notice', () => {
    // The history row of folded input carries the uuid the Controller gave it, which its live row has.
    const live = run(new ClaudeEventProjector('session', 'live'), [user('steer-1', 'Also this'), user('n1', [{ type: 'text', text: '[Request interrupted by user]' }])]);
    const history = run(new ClaudeEventProjector('session', 'history'), [user('steer-1', 'Also this'), user('n1', [{ type: 'text', text: '[Request interrupted by user]' }])]);
    expect(live.map(row => [row.itemIdentity, (item(row) as { messageId?: string }).messageId])).toEqual(history.map(row => [row.itemIdentity, (item(row) as { messageId?: string }).messageId]));
    expect(live.map(row => row.itemIdentity?.key)).toEqual(['user:steer-1', 'user:n1']);
  });

  it('reads the envelope of a typed slash command as the command was typed, so the transcript row equals the live row', () => {
    const envelope = '<command-message>hello</command-message>\n<command-name>/hello</command-name>\n<command-args>world</command-args>';
    const builtIn = '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>';
    const history = run(new ClaudeEventProjector('session', 'history'), [user('c1', envelope), user('c2', builtIn), user('c3', 'Mention <command-name>/x</command-name> in prose')]);
    expect(history.map(text)).toEqual(['/hello world', '/context', 'Mention <command-name>/x</command-name> in prose']);
    expect(run(new ClaudeEventProjector('session', 'live'), [user('c1', '/hello world')]).map(text)).toEqual(['/hello world']);
  });

  it('keeps the output of a local command live-only, since the SDK read omits it, and gives a recorded synthetic record no mark', () => {
    const output = assistant('s1', [{ type: 'text', text: '## Context Usage' }], '<synthetic>', 'synthetic-1');
    const [live] = run(new ClaudeEventProjector('session', 'live'), [output]);
    expect(live!.itemIdentity).toEqual({ key: 'assistant:synthetic-1:0', completes: true, liveOnly: true });
    const [history] = run(new ClaudeEventProjector('session', 'history'), [output]);
    expect(history!.itemIdentity).toEqual({ key: 'assistant:synthetic-1:0', completes: true });
  });

  it('marks as live-only nothing the projector makes: a TodoWrite is rebuilt from its tool row, and reasoning from its record', () => {
    const everything = [...run(new ClaudeEventProjector('session', 'live'), [...turn, assistant('t1', [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }], 'claude', 'msg-3')]),
      ...run(new ClaudeEventProjector('session', 'history'), [...records, assistant('t1', [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }], 'claude', 'msg-3')])];
    expect(timeline(everything).filter(({ itemIdentity }) => itemIdentity?.liveOnly === true)).toEqual([]);
    expect(keys(everything)).toContain('todo:todo-1');
  });

  it('makes a compaction one item: the status row opens it, the boundary completes it, and a boundary alone is an item of its own', () => {
    const projector = new ClaudeEventProjector('session', 'live');
    const rows = run(projector, [{ ...envelope, type: 'system', subtype: 'status', status: 'compacting', uuid: 'status-1' },
      { ...envelope, type: 'system', subtype: 'compact_boundary', uuid: 'boundary-1', compact_metadata: { trigger: 'manual', pre_tokens: 100 } },
      { ...envelope, type: 'system', subtype: 'compact_boundary', uuid: 'boundary-2' }]);
    expect(rows.map(row => [row.itemIdentity?.key, (item(row) as { status: string }).status, row.itemIdentity?.completes === true])).toEqual([
      ['compaction:status-1', 'loading', false], ['compaction:status-1', 'completed', true], ['compaction:boundary-2', 'completed', true],
    ]);
  });

  it('ends what a turn left open when it ends: streamed text and thinking with an empty body, a compaction as failed', () => {
    const projector = new ClaudeEventProjector('session', 'live');
    run(projector, [stream({ type: 'message_start', message: { id: 'msg-1' } }), stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think' } }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Half' } }),
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
      { ...envelope, type: 'system', subtype: 'status', status: 'compacting', uuid: 'status-1' }]);
    const finished = projector.finishOpenItems();
    expect(finished.map(row => [row.itemIdentity?.key, row.itemIdentity?.completes, row.itemIdentity?.liveOnly])).toEqual([
      ['reasoning:msg-1:0', true, undefined], ['assistant:msg-1:1', true, undefined], ['compaction:status-1', true, undefined],
    ]);
    expect(finished.map(row => text(row) ?? (item(row) as { status?: string }).status)).toEqual(['', '', 'failed']);
    expect(projector.finishOpenItems()).toEqual([]);
  });

  it('reads the same history five times and adds no item after the first', () => {
    const opened = Array.from({ length: 5 }, () => keys(run(new ClaudeEventProjector('session', 'history'), records)));
    for (const keysOfOpen of opened) expect(keysOfOpen).toEqual(opened[0]);
  });

  it('keeps the rows of a withdrawn input under its own uuid, which no transcript holds', () => {
    const [withdrawn] = run(new ClaudeEventProjector('session', 'live'), [user('steer-2', 'Never ran')]);
    expect(withdrawn!.itemIdentity).toEqual({ key: 'user:steer-2', completes: true });
  });
});
