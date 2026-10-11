import { expect, it } from 'vitest';
import { decodeClientMessage, decodeServerMessage } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

it('carries optional message delivery on the existing send request', () => {
  const message = { protocolVersion: PROTOCOL_VERSION, type: 'send_message', payload: { requestId: 'r', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a', text: 'Do this next' } };
  expect(decodeClientMessage(JSON.stringify(message)).status).toBe('ok');
  for (const delivery of ['immediate', 'next_turn']) {
    expect(decodeClientMessage(JSON.stringify({ ...message, payload: { ...message.payload, delivery } })).status).toBe('ok');
  }
  expect(decodeClientMessage(JSON.stringify({ ...message, payload: { ...message.payload, delivery: 'priority' } })).status).toBe('rejected');
});


it('preserves authoritative input acceptance without requiring it from legacy adapters', () => {
  const message = { protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: { requestId: 'r', agentId: 'a', command: 'send_message' } };
  expect(decodeServerMessage(JSON.stringify(message)).status).toBe('ok');
  for (const disposition of ['started', 'queued', 'handled']) {
    const result = decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, inputAcceptance: { disposition } } }));
    expect(result).toMatchObject({ status: 'ok', value: { payload: { inputAcceptance: { disposition } } } });
  }
  expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, inputAcceptance: { disposition: 'completed' } } })).status).toBe('rejected');
});

it('carries a bounded exact submitted-text digest without changing input disposition', () => {
  const message = { protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: {
    requestId: 'r', agentId: 'a', command: 'send_message',
    submittedTextSha256: 'a'.repeat(64),
  } };
  expect(decodeServerMessage(JSON.stringify(message))).toMatchObject({ status: 'ok', value: message });
  for (const submittedTextSha256 of ['', 'a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64)]) {
    expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload,
      submittedTextSha256,
    } })).status).toBe('rejected');
  }
});
