import { expect, it } from 'vitest';
import { DshProjector } from './projector.js';
function event(recordId: string, type: string, data: unknown) { return { recordId, occurredAt: 1, kind: 'session_event' as const, payload: { type, data } }; }
it.each([false, true])('retains DSH tool result content when isError is %s', (isError) => {
  const projector = new DshProjector({ sessionId: 'test', tools: { get: () => undefined } });
  projector.project(event('call', 'tool/call', { callId: 'call', name: 'bash', arguments: '{"command":"echo hello"}' }));
  const output = projector.project(event('result', 'tool/result', { message: { source: { callId: 'call' }, content: [{ type: 'tool-result', isError, content: [{ type: 'text', text: 'hello\n' }, { type: 'json', value: { answer: 42 } }] }] } }));
  expect(output).toMatchObject([{ event: { item: { callId: 'call', status: isError ? 'failed' : 'completed', result: { content: [{ type: 'text', text: 'hello\n' }, { type: 'json', value: { answer: 42 } }] } } } }]);
});
