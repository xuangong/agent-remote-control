import { expect, it, vi } from 'vitest';
import { createOperationCache, OperationCacheError } from './operation-cache.js';
import { createOperationExecutor } from './operation-settlement.js';
import { createSessionWire, type SessionWireAgent } from './session-wire.js';

function agent(nativeId: string | null = 'native'): SessionWireAgent {
  return {
    agentId: 'agent',
    snapshot: () => ({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: {
      id: 'agent', providerId: 'fixture', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z', status: 'idle', activeTurn: null, pendingInteractions: [],
      capabilities: { history: false, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
      runtimeInfo: { providerId: 'fixture', sessionId: nativeId, status: 'idle' },
    } }),
    fetchTimeline() { throw new Error('Unused'); }, subscribe: () => () => {}, async sendMessage() {}, async respondToInteraction() {},
  };
}
const operation = { operationId: '00000000-0000-4000-8000-000000000001', kind: 'send_message' as const, parameters: { text: 'hello' }, maximumResultBytes: 1024 };

it('keeps lifecycle admission, resource retention and uncertainty separate from cached settlement', async () => {
  const cache = createOperationCache();
  const target = agent(); let draining = true;
  const release = vi.fn(() => { throw new Error('Cleanup diagnostic'); });
  const retain = vi.fn(() => release); const uncertain = vi.fn(() => { throw new Error('Diagnostic failure'); });
  const execute = createOperationExecutor(cache, 'scope', {
    admit: () => { if (draining) throw new OperationCacheError('service_draining', 'Draining'); }, retain, uncertain,
  });
  const dispatch = vi.fn(async () => { throw new Error('Lost native reply'); });
  try {
    await expect(execute(target, operation, { dispatch })).rejects.toMatchObject({ code: 'service_draining' });
    expect(retain).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    draining = false;
    await expect(execute(target, operation, { dispatch })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    await expect(execute(target, operation, { dispatch })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(dispatch).toHaveBeenCalledOnce(); expect(retain).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2); expect(uncertain).toHaveBeenCalledTimes(2);
  } finally { await cache.close(); }
}, 10000);

it('uses separate ephemeral native incarnations while reconnecting executors share the same runtime identity', async () => {
  const cache = createOperationCache(); const targets = new WeakMap<SessionWireAgent, string>();
  const target = agent(null); const dispatch = vi.fn(async () => ({ accepted: true }));
  try {
    await createOperationExecutor(cache, 'scope', {}, targets)(target, operation, { dispatch });
    await createOperationExecutor(cache, 'scope', {}, targets)(target, operation, { dispatch });
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(createOperationExecutor(cache, 'scope', {}, targets)(agent(null), operation, { dispatch })).rejects.toMatchObject({ code: 'operation_conflict' });
  } finally { await cache.close(); }
}, 10000);

it('rejects writable public wires without a runtime settlement service', async () => {
  const target = agent(); const dispatch = vi.fn(async () => {}); target.sendMessage = dispatch;
  const output: any[] = [];
  const wire = createSessionWire(target, json => output.push(JSON.parse(json)));
  try {
    await wire.receive(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    await wire.receive(JSON.stringify({ protocolVersion: '1.5.0', type: 'send_message', payload: { requestId: 'send', agentId: 'agent', operationId: operation.operationId, text: 'hello' } }));
    expect(output.at(-1)).toMatchObject({ type: 'protocol_error', payload: { code: 'operation_settlement_unavailable' } });
    expect(dispatch).not.toHaveBeenCalled();
  } finally { wire.close(); }
}, 10000);
