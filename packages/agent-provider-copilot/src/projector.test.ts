import {expect, it} from 'vitest';
import type {SessionEvent} from '@github/copilot-sdk';
import {Projector} from './projector.js';
function event(type: string, data: unknown): SessionEvent {return {type, data, id: Math.random().toString(), timestamp: new Date().toISOString(), parentId: null} as SessionEvent;}
it('replaces streamed message snapshots with durable text and preserves tool identity', () => {
 const projector = new Projector();
 const first = projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'Hel'}))!;
 const second = projector.project(event('assistant.message_delta', {messageId: 'm', deltaContent: 'lo'}))!;
 const final = projector.project(event('assistant.message', {messageId: 'm', content: 'Hello'}))!;
 expect(first.key).toBe(final.key); expect(second.event).toMatchObject({item: {text: 'Hello'}});
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
}, 10000);
it('reports compaction failure without claiming completion or failing the turn', () => {
 expect(new Projector().project(event('session.compaction_complete', {success: false, error: 'context unavailable'}))?.event).toMatchObject({type: 'timeline', item: {type: 'error', message: expect.stringContaining('context unavailable')}});
}, 10000);
