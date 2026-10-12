import { expect, it } from 'vitest';
import { sessionIdentityMessage } from './session-identity.js';

const client = (type: string, payload: unknown) => JSON.stringify({ protocolVersion: '1.7.0', type, payload });
it('leaves protocol negotiation and version rejection to the endpoints', () => {
  const negotiate = JSON.stringify({ protocolVersion: 'future-version', type: 'negotiate' });
  expect(sessionIdentityMessage(negotiate, 'public', 'runtime', 'client')).toBe(negotiate);
  const error = JSON.stringify({ protocolVersion: 'future-version', type: 'protocol_error', payload: { code: 'incompatible_protocol_version', message: 'Unsupported version' } });
  expect(sessionIdentityMessage(error, 'runtime', 'public', 'server')).toBe(error);
});
it('changes the target address without rewriting user content or operation identity', () => {
  const input = client('send_message', { agentId: 'public', requestId: 'public', operationId: '00000000-0000-4000-8000-000000000001', text: 'public' });
  expect(JSON.parse(sessionIdentityMessage(input, 'public', 'runtime', 'client')).payload).toEqual({
    agentId: 'runtime', requestId: 'public', operationId: '00000000-0000-4000-8000-000000000001', text: 'public',
  });
});
it('preserves native turn identities, event content and timeline positions', () => {
  const input = client('agent_stream', { agentId: 'runtime', timestamp: '2026-10-12T00:00:00Z', seq: 7, epoch: 'runtime',
    event: { type: 'timeline', providerId: 'codex', turnId: 'runtime', resources: [], item: { type: 'assistant_message', text: 'runtime' } } });
  const expected = JSON.parse(input); expected.payload.agentId = 'public';
  expect(JSON.parse(sessionIdentityMessage(input, 'runtime', 'public', 'server'))).toEqual(expected);
});
it.each(['timeline_subscription', 'timeline_subscribed'])('maps %s without inventing subscriptions', type => {
  const direction = type === 'timeline_subscription' ? 'client' : 'server';
  expect(JSON.parse(sessionIdentityMessage(client(type, { requestId: 'subscribe', agentIds: ['from'] }), 'from', 'to', direction)).payload.agentIds).toEqual(['to']);
  expect(JSON.parse(sessionIdentityMessage(client(type, { requestId: 'subscribe', agentIds: [] }), 'from', 'to', direction)).payload.agentIds).toEqual([]);
  expect(() => sessionIdentityMessage(client(type, { requestId: 'subscribe', agentIds: ['other'] }), 'from', 'to', direction)).toThrow('another binding');
});
it('rejects foreign client and server targets instead of converting them into the authorized session', () => {
  expect(() => sessionIdentityMessage(client('cancel', { agentId: 'other', requestId: 'cancel', operationId: '00000000-0000-4000-8000-000000000001' }), 'public', 'runtime', 'client')).toThrow('another binding');
  expect(() => sessionIdentityMessage(client('agent_activity', { agentId: 'other', status: 'idle' }), 'runtime', 'public', 'server')).toThrow('another binding');
});
