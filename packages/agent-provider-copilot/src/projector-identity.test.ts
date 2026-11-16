import {describe, expect, it} from 'vitest';
import type {SessionEvent} from '@github/copilot-sdk';
import {Projector, type Projected} from './projector.js';
import {interactionResponse, interactionRequest} from './interaction-mapping.js';

let counter = 0;
function event(type: string, data: unknown): SessionEvent {return {type, data, id: `e${++counter}`, timestamp: new Date().toISOString(), parentId: null} as SessionEvent;}
const live = (events: SessionEvent[]) => { const p = new Projector(); return events.flatMap(e => p.projectAll(e, 'live')); };
const history = (events: SessionEvent[]) => { const p = new Projector(); p.prepareHistory(events); return events.flatMap(e => p.projectAll(e, 'history')); };
const timeline = (projected: Projected[]) => projected.filter(p => p.event.type === 'timeline');
const keys = (projected: Projected[]) => timeline(projected).map(p => p.identity?.key);

/** One streamed turn: user, reasoning, text, a tool with partial output, compaction, an error and an approval. */
function turn() {
  const user = event('user.message', {content: 'Fix it'});
  const events = [
    user, event('assistant.turn_start', {turnId: '0'}),
    event('assistant.reasoning_delta', {reasoningId: 'r1', deltaContent: 'Think'}), event('assistant.reasoning', {reasoningId: 'r1', content: 'Thinking'}),
    event('assistant.message_delta', {messageId: 'm1', deltaContent: 'On '}), event('assistant.message_delta', {messageId: 'm1', deltaContent: 'it.'}), event('assistant.message', {messageId: 'm1', content: 'On it.'}),
    event('tool.execution_start', {toolCallId: 't1', toolName: 'bash', arguments: {command: 'ls'}}), event('tool.execution_partial_result', {toolCallId: 't1', partialOutput: 'a'}),
    event('tool.execution_complete', {toolCallId: 't1', success: true, result: {content: 'a\nb'}}),
    event('session.compaction_start', {}), event('session.compaction_complete', {success: true, trigger: 'auto', preCompactionTokens: 10}),
    event('assistant.turn_end', {turnId: '0'}), event('assistant.idle', {}),
  ];
  return events;
}

describe('the item identity of a Copilot timeline observation', () => {
  it('gives every timeline observation of a turn a key, none of them a controller key, and the same keys live as from history', () => {
    const events = turn();
    const liveKeys = new Set(keys(live(events))); const historyKeys = new Set(keys(history(events.filter(e => e.type !== 'assistant.idle' && !e.type.endsWith('_delta') && e.type !== 'tool.execution_partial_result'))));
    expect(timeline(live(events)).every(p => p.identity !== undefined)).toBe(true);
    expect([...liveKeys].every(key => !key!.startsWith('controller:'))).toBe(true);
    expect([...liveKeys].sort()).toEqual([`user:${events[0]!.id}`, 'reasoning:r1', 'assistant:m1', 'tool:t1', `compaction:${events[10]!.id}`].sort());
    expect([...historyKeys].sort()).toEqual([...liveKeys].sort());
  });

  it('completes a streamed text with an empty body when the final equals the stream, and with the suffix when it extends it', () => {
    const equal = live([event('assistant.message_delta', {messageId: 'a', deltaContent: 'Hi'}), event('assistant.message', {messageId: 'a', content: 'Hi'})]);
    expect(equal.map(p => [p.event.type === 'timeline' && p.event.item.type === 'assistant_message' ? p.event.item.text : null, p.identity])).toEqual([['Hi', {key: 'assistant:a'}], ['', {key: 'assistant:a', completes: true}]]);
    const extended = live([event('assistant.message_delta', {messageId: 'b', deltaContent: 'Hi'}), event('assistant.message', {messageId: 'b', content: 'Hi there'})]);
    expect(extended[1]).toMatchObject({event: {item: {text: ' there'}}, identity: {key: 'assistant:b', completes: true}});
    const whole = live([event('assistant.message', {messageId: 'c', content: 'Whole'})]);
    expect(whole).toMatchObject([{event: {item: {text: 'Whole'}}, identity: {key: 'assistant:c', completes: true}}]);
  });

  it('completes a corrected text with an empty body and a complete correction item, and gives an empty message nothing', () => {
    const corrected = live([event('assistant.message_delta', {messageId: 'a', deltaContent: 'Draft'}), event('assistant.message', {messageId: 'a', content: 'Final'})]);
    expect(corrected.slice(1).map(p => [p.event.type === 'timeline' && p.event.item.type === 'assistant_message' ? p.event.item.text : null, p.identity])).toEqual([['', {key: 'assistant:a', completes: true}], ['Final', {key: 'assistant:a:correction', completes: true}]]);
    expect(live([event('assistant.message', {messageId: 'e', content: ''})])).toEqual([]);
    expect(history([event('assistant.message', {messageId: 'e', content: ''})])).toEqual([]);
  });

  it('keys reasoning by its id as live-only, with the same body live and from history when history holds it', () => {
    const events = [event('assistant.reasoning_delta', {reasoningId: 'r', deltaContent: 'Draft'}), event('assistant.reasoning', {reasoningId: 'r', content: 'Rewritten'})];
    const projected = live(events);
    expect(projected.map(p => p.identity)).toEqual([{key: 'reasoning:r', liveOnly: true}, {key: 'reasoning:r', completes: true, liveOnly: true}]);
    const text = (p: Projected) => p.event.type === 'timeline' && p.event.item.type === 'reasoning' ? p.event.item.text : null;
    expect(text(projected[1]!)).toBe('Rewritten');
    expect(history([events[1]!]).map(text)).toEqual(['Rewritten']);
    expect(live([event('assistant.reasoning', {reasoningId: 'z', content: ' '})])).toEqual([]);
  });

  it('completes a tool only with its result, so a tool without one stays open in history', () => {
    const start = event('tool.execution_start', {toolCallId: 't', toolName: 'bash', arguments: {command: 'ls'}});
    expect(history([start]).map(p => p.identity)).toEqual([{key: 'tool:t'}]);
    const finished = history([start, event('tool.execution_complete', {toolCallId: 't', success: true, result: {content: 'x'}})]);
    expect(finished.map(p => p.identity)).toEqual([{key: 'tool:t'}, {key: 'tool:t', completes: true}]);
  });

  it('finishes the compaction that began, for a success and for a failure', () => {
    const start = event('session.compaction_start', {});
    const done = live([start, event('session.compaction_complete', {success: true})]);
    expect(done.map(p => p.identity)).toEqual([{key: `compaction:${start.id}`}, {key: `compaction:${start.id}`, completes: true}]);
    const failed = live([start, event('session.compaction_complete', {success: false, error: 'No room'})]);
    expect(failed.map(p => [p.event.type === 'timeline' ? p.event.item.type : null, p.identity?.key, p.identity?.completes])).toEqual([
      ['compaction', `compaction:${start.id}`, undefined], ['compaction', `compaction:${start.id}`, true], ['error', expect.stringMatching(/^error:/), true],
    ]);
  });

  it('finishes streamed text and reasoning that never got a final message when the turn is aborted, as live-only items', () => {
    const projected = live([
      event('assistant.turn_start', {turnId: '0'}), event('assistant.message_delta', {messageId: 'm', deltaContent: 'Half'}), event('assistant.reasoning_delta', {reasoningId: 'r', deltaContent: 'Hmm'}),
      event('assistant.message_delta', {messageId: 'done', deltaContent: 'Ok'}), event('assistant.message', {messageId: 'done', content: 'Ok'}), event('abort', {}),
    ]);
    const ends = projected.slice(-3);
    expect(ends.map(p => p.event.type)).toEqual(['timeline', 'timeline', 'turn_canceled']);
    expect(ends.slice(0, 2).map(p => [p.event.type === 'timeline' ? (p.event.item as {text: string}).text : null, p.identity])).toEqual([
      ['', {key: 'assistant:m', completes: true, liveOnly: true}], ['', {key: 'reasoning:r', completes: true, liveOnly: true}],
    ]);
  });

  it('keys a tool approval read from history by its request, not live-only', () => {
    const permission = event('permission.requested', {requestId: 'p', permissionRequest: {kind: 'shell'}});
    const answer = event('permission.completed', {requestId: 'p', result: {kind: 'approved'}});
    expect(history([permission, answer]).map(p => p.identity)).toEqual([{key: 'interaction:p', completes: true}]);
  });

  it('maps an approval for the session or for the location to the session scope', () => {
    const permission = event('permission.requested', {requestId: 'p', permissionRequest: {kind: 'shell'}});
    const request = interactionRequest(permission)!;
    for (const kind of ['approved-for-session', 'approved-for-location']) {
      expect(interactionResponse(event('permission.completed', {requestId: 'p', result: {kind}}), request)).toEqual({kind: 'tool_approval', decision: 'allow', scope: 'session'});
    }
    expect(interactionResponse(event('permission.completed', {requestId: 'p', result: {kind: 'approved'}}), request)).toEqual({kind: 'tool_approval', decision: 'allow', scope: 'once'});
  });
});
