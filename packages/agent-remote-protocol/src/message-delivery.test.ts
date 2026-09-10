import { expect, it } from 'vitest';
import { decodeClientMessage } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

it('carries optional message delivery on the existing send request', () => {
  const message = { protocolVersion: PROTOCOL_VERSION, type: 'send_message', payload: { requestId: 'r', agentId: 'a', text: 'Do this next' } };
  expect(decodeClientMessage(JSON.stringify(message)).status).toBe('ok');
  for (const delivery of ['immediate', 'next_turn']) {
    expect(decodeClientMessage(JSON.stringify({ ...message, payload: { ...message.payload, delivery } })).status).toBe('ok');
  }
  expect(decodeClientMessage(JSON.stringify({ ...message, payload: { ...message.payload, delivery: 'priority' } })).status).toBe('rejected');
});
