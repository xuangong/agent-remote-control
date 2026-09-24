import {expect, it} from 'vitest';
import type {SessionEvent} from '@github/copilot-sdk';
import {Projector} from './projector.js';
function event(type: string, data: unknown): SessionEvent {return {type, data, id: Math.random().toString(), timestamp: new Date().toISOString(), parentId: null} as SessionEvent;}
it('appends native deltas without duplicating durable text and preserves tool identity', () => {
 const projector = new Projector();
 const first = projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'Hel'}))!;
 const second = projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'lo'}))!;
 const final = projector.project(event('assistant.message', {messageId: 'm', content: 'Hello'}));
 expect(first.key).toBe(second.key); expect(first.event).toMatchObject({item: {text: 'Hel'}}); expect(second.event).toMatchObject({item: {text: 'lo'}}); expect(final).toBeUndefined();
 projector.project(event('tool.execution_start', {toolCallId: 't', toolName: 'bash', arguments: {command: 'pwd'}}));
 expect(projector.project(event('tool.execution_complete', {toolCallId: 't', success: false, error: {message: 'No'}, result: {content: 'stderr'}}))?.event).toMatchObject({item: {name: 'bash', detail: {type: 'shell', command: 'pwd'}, status: 'failed', error: 'No'}});
}, 10000);
it('gives repeated native child turn zero distinct public turn identities', () => {
 const projector = new Projector();
 const first = projector.project(event('assistant.turn_start', {turnId: '0'}))!;
 expect(projector.project(event('assistant.turn_end', {turnId: '0'}))).toBeUndefined();
 const firstEnd = projector.project(event('assistant.idle', {}))!;
 const second = projector.project(event('assistant.turn_start', {turnId: '0'}))!;
 expect(first.event).toHaveProperty('turnId', (firstEnd.event as {turnId: string}).turnId);
 expect((first.event as {turnId: string}).turnId).not.toBe((second.event as {turnId: string}).turnId);
}, 10000);
it('reconstructs historical foreground turns across multiple model steps without ephemeral idle events', () => {
 const projector = new Projector();
 const history = [event('user.message', {content: 'First'}), event('assistant.turn_start', {turnId: '0'}), event('assistant.turn_end', {turnId: '0'}), event('assistant.turn_start', {turnId: '1'}), event('assistant.turn_end', {turnId: '1'}), event('user.message', {content: 'Second'}), event('assistant.turn_start', {turnId: '0'}), event('assistant.turn_end', {turnId: '0'})];
 projector.prepareHistory(history);
 const projected = history.map(e => projector.project(e, 'history')?.event).filter(e => e?.type === 'turn_started' || e?.type === 'turn_completed');
 expect(projected.map(e => e!.type)).toEqual(['turn_started', 'turn_completed', 'turn_started', 'turn_completed']);
}, 10000);
it.each(['live', 'history'] as const)('keeps queued interactions distinct and steering together in %s', delivery => {
 const projector = new Projector();
 const events = [event('user.message', {content: 'First', interactionId: 'a', delivery: 'idle'}), event('assistant.turn_start', {turnId: '0', interactionId: 'a'}), event('assistant.turn_end', {turnId: '0', interactionId: 'a'}), event('user.message', {content: 'Steer', interactionId: 'a', delivery: 'steering'}), event('assistant.turn_start', {turnId: '1', interactionId: 'a'}), event('assistant.turn_end', {turnId: '1', interactionId: 'a'}), event('user.message', {content: 'Second', interactionId: 'b', delivery: 'queued'}), event('assistant.turn_start', {turnId: '0', interactionId: 'b'}), event('assistant.turn_end', {turnId: '0', interactionId: 'b'}), event('assistant.idle', {})];
 if (delivery === 'history') projector.prepareHistory(events);
 const projected = events.flatMap(e => projector.projectAll(e, delivery)).map(p => p.event);
 expect(projected.filter(e => e.type === 'turn_started' || e.type === 'turn_completed').map(e => e.type)).toEqual(['turn_started', 'turn_completed', 'turn_started', 'turn_completed']);
 const starts = projected.filter(e => e.type === 'turn_started');
 expect(starts[0]?.turnId).not.toBe(starts[1]?.turnId);
 const users = projected.filter(e => e.type === 'timeline' && e.item.type === 'user_message');
 expect(users.map(e => e.turnId)).toEqual([starts[0]!.turnId, starts[0]!.turnId, starts[1]!.turnId]);
}, 10000);
it('reports compaction failure without claiming completion or failing the turn', () => {
 expect(new Projector().project(event('session.compaction_complete', {success: false, error: 'context unavailable'}))?.event).toMatchObject({type: 'timeline', item: {type: 'error', message: expect.stringContaining('context unavailable')}});
}, 10000);

it('assigns input after a completed ordinary turn to its new turn', () => {
 const projector = new Projector();
 const projected = [event('user.message', {content: 'First'}), event('assistant.turn_start', {turnId: '0'}), event('assistant.idle', {}), event('user.message', {content: 'Second'}), event('assistant.turn_start', {turnId: '0'})].flatMap(e => projector.projectAll(e)).map(p => p.event);
 const users = projected.filter(e => e.type === 'timeline' && e.item.type === 'user_message');
 const starts = projected.filter(e => e.type === 'turn_started');
 expect(users.map(e => e.turnId)).toEqual(starts.map(e => e.turnId));
 expect(starts[0]!.turnId).not.toBe(starts[1]!.turnId);
}, 10000);

it('emits only an unsent final suffix and suppresses late deltas and duplicate finals', () => {
 const projector = new Projector();
 projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'Hello'}));
 expect(projector.project(event('assistant.message', {messageId: 'm', content: 'Hello world'}))?.event).toMatchObject({item: {messageId: 'm', text: ' world'}});
 expect(projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: ' world'}))).toBeUndefined();
 expect(projector.project(event('assistant.message', {messageId: 'm', content: 'Hello world'}))).toBeUndefined();
}, 10000);
it('preserves a non-prefix final correction under a separate message identity', () => {
 const projector = new Projector();
 projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'Draft'}));
 expect(projector.project(event('assistant.message', {messageId: 'm', content: 'Corrected'}))?.event).toMatchObject({item: {messageId: 'm:correction', text: 'Corrected'}});
}, 10000);

it('preserves background follow-up turn identity without ephemeral idle history', () => {
 const first = event('user.message', {content: 'Work', interactionId: 'a'});
 const followup = event('assistant.turn_start', {turnId: '0', interactionId: 'a'});
 const events = [first, event('assistant.turn_start', {turnId: '0', interactionId: 'a'}), event('assistant.turn_end', {turnId: '0'}), event('assistant.turn_start', {turnId: '1', interactionId: 'a'}), event('assistant.message', {messageId: 'first', content: 'Done'}), event('assistant.turn_end', {turnId: '1'}), event('assistant.idle', {}), event('system.notification', {content: 'Background tool finished'}), followup, event('assistant.message', {messageId: 'second', content: 'Done'}), event('assistant.turn_end', {turnId: '0'}), event('assistant.idle', {})];
 const live = new Projector(); const history = new Projector(); const durable = events.filter(e => e.type !== 'assistant.idle'); history.prepareHistory(durable);
 const messages = (p: Projector, es: SessionEvent[], delivery: 'live' | 'history') => es.flatMap(e => p.projectAll(e, delivery)).flatMap(p => p.event.type === 'timeline' && p.event.item.type === 'assistant_message' ? [{id: p.event.item.messageId, turnId: p.event.turnId}] : []);
 expect(messages(history, durable, 'history')).toEqual(messages(live, events, 'live'));
}, 10000);
it('does not emit empty reasoning and maps context usage without inventing monetary cost', () => {
 const p = new Projector();
 expect(p.project(event('assistant.reasoning', {reasoningId: 'r', content: ''}))).toBeUndefined();
 expect(p.project(event('session.usage_info', {currentTokens: 120, tokenLimit: 1000, messagesLength: 3}))?.event).toMatchObject({type: 'usage_updated', usage: {contextWindowUsedTokens: 120, contextWindowMaxTokens: 1000}});
 expect(p.project(event('assistant.usage', {model: 'm', cost: 2, inputTokens: 5}))?.event).not.toHaveProperty('usage.totalCostUsd');
}, 10000);
it('reconstructs completed historical interactions without reopening pending prompts', () => {
 const p = new Projector();
 const events = [event('permission.requested', {requestId: 'r', permissionRequest: {kind: 'shell', command: 'pwd', toolCallId: 'tool'}}), event('permission.completed', {requestId: 'r', result: {kind: 'approved'}}), event('permission.requested', {requestId: 'unmatched', permissionRequest: {kind: 'shell'}})];
 p.prepareHistory(events);
 const projected = events.flatMap(e => p.projectAll(e, 'history')).map(p => p.event);
 expect(projected).toEqual([expect.objectContaining({type: 'timeline', item: expect.objectContaining({type: 'interaction', request: expect.objectContaining({requestId: 'r'}), response: {kind: 'tool_approval', decision: 'allow', scope: 'once'}})})]);
}, 10000);

it('streams reasoning once and keeps bounded tool output snapshots through completion', () => {
 const p = new Projector();
 const reasoning = [event('assistant.reasoning_delta', {reasoningId: 'r', deltaContent: 'Think'}), event('assistant.reasoning_delta', {reasoningId: 'r', deltaContent: 'ing'}), event('assistant.reasoning', {reasoningId: 'r', content: 'Thinking carefully'})].flatMap(e => p.projectAll(e)).map(p => p.event);
 expect(reasoning.map(e => e.type === 'timeline' && e.item.type === 'reasoning' ? e.item.text : '')).toEqual(['Think', 'ing', ' carefully']);
 expect(p.project(event('assistant.reasoning_delta', {reasoningId: 'r', deltaContent: ' carefully'}))).toBeUndefined();
 p.project(event('tool.execution_start', {toolCallId: 't', toolName: 'bash', arguments: {command: 'echo hello'}}));
 p.project(event('tool.execution_partial_result', {toolCallId: 't', partialOutput: 'hel'}));
 expect(p.project(event('tool.execution_partial_result', {toolCallId: 't', partialOutput: 'lo'}))?.event).toMatchObject({item: {status: 'running', result: {content: [{type: 'text', text: 'hello'}]}}});
 const final = p.project(event('tool.execution_complete', {toolCallId: 't', success: true, result: {content: 'hello!', structuredContent: {ok: true}}}));
 expect(final?.event).toMatchObject({item: {status: 'completed', result: {content: [{type: 'text', text: 'hello!'}, {type: 'json', value: {ok: true}}]}}});
 expect(p.project(event('tool.execution_partial_result', {toolCallId: 't', partialOutput: 'late'}))).toBeUndefined();
}, 10000);

it('projects native failure and cancellation as distinct public terminal events', () => {
 const failed = new Projector();
 const start = failed.project(event('assistant.turn_start', {turnId: '0'}))!.event;
 expect(failed.project(event('session.error', {errorType: 'model', message: 'Model unavailable'}))?.event).toMatchObject({type: 'turn_failed', error: 'Model unavailable', turnId: 'turnId' in start ? start.turnId : undefined});
 expect(failed.project(event('assistant.idle', {}))).toBeUndefined();
 const canceled = new Projector(); canceled.project(event('assistant.turn_start', {turnId: '0'}));
 expect(canceled.project(event('abort', {}))?.event).toMatchObject({type: 'turn_canceled', reason: 'Native turn aborted'});
 expect(canceled.project(event('assistant.idle', {}))).toBeUndefined();
}, 10000);

it('retains successful compaction metadata and native token counts', () => {
 const p = new Projector();
 expect(p.project(event('session.compaction_start', {}))?.event).toMatchObject({item: {type: 'compaction', status: 'loading'}});
 expect(p.project(event('session.compaction_complete', {success: true, trigger: 'manual', preCompactionTokens: 900}))?.event).toMatchObject({item: {type: 'compaction', status: 'completed', trigger: 'manual', preTokens: 900}});
 expect(p.project(event('assistant.usage', {inputTokens: 12, outputTokens: 5, cacheReadTokens: 8, cost: 1}))?.event).toEqual({type: 'usage_updated', provider: 'copilot', turnId: undefined, usage: {inputTokens: 12, outputTokens: 5, cachedInputTokens: 8}});
}, 10000);
