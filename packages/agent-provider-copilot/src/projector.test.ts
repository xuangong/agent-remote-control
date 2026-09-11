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
