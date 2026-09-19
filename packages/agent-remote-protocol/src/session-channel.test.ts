import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

const version = '1.5.0' as const;
const negotiate = { protocolVersion: version, type: 'negotiate' as const };
const frame = (type: string, rest = {}) => ({ protocolVersion: version, type, ...rest });

describe('session channel framing', () => {
  it('round trips all client and server frame kinds', () => {
    expect(protocol.encodeSessionChannelClientMessage).toBeTypeOf('function');
    for (const value of [frame('subscribe', { subscriptionId: 1, agentId: 'a', message: negotiate }), frame('message', { subscriptionId: 1, message: negotiate }), frame('unsubscribe', { subscriptionId: 1 }), frame('ping')]) {
      const encoded = protocol.encodeSessionChannelClientMessage(value as never);
      expect(encoded.status).toBe('ok');
      if (encoded.status === 'ok') expect(protocol.decodeSessionChannelClientMessage(encoded.json)).toEqual({ status: 'ok', value });
    }
    for (const value of [frame('ready'), frame('pong'), frame('closed', { subscriptionId: 1, code: 1008, reason: 'Denied' }), frame('message', { subscriptionId: 1, message: { protocolVersion: version, type: 'negotiated' } }), frame('message', { subscriptionId: 1, message: { protocolVersion: '2.0.0', type: 'protocol_error', payload: { code: 'incompatible_protocol_version', message: 'Upgrade', recoverable: false } } })]) {
      const encoded = protocol.encodeSessionChannelServerMessage(value as never);
      expect(encoded.status).toBe('ok');
      if (encoded.status === 'ok') expect(protocol.decodeSessionChannelServerMessage(encoded.json)).toEqual({ status: 'ok', value });
    }
  });

  it('rejects unsafe IDs, extra fields, wrong versions and invalid nested messages', () => {
    expect(protocol.decodeSessionChannelClientMessage).toBeTypeOf('function');
    for (const subscriptionId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(protocol.decodeSessionChannelClientMessage(JSON.stringify(frame('unsubscribe', { subscriptionId }))).status).toBe('rejected');
    }
    for (const value of [frame('ping', { extra: true }), { ...frame('ping'), protocolVersion: '2.0.0' }, frame('subscribe', { subscriptionId: 1, agentId: '', message: negotiate }), frame('subscribe', { subscriptionId: 1, agentId: 'a', message: { ...negotiate, type: 'cancel' } }), frame('message', { subscriptionId: 1, message: { ...negotiate, protocolVersion: '2.0.0' } })]) {
      expect(protocol.decodeSessionChannelClientMessage(JSON.stringify(value)).status).toBe('rejected');
    }
    expect(protocol.decodeSessionChannelClientMessage('{').status).toBe('rejected');
  });
});
