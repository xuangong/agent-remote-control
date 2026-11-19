import { expect, it } from 'vitest';
import { parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-protocol/model';
import { event, send } from './test-utils/relay-harness.js';
import { world } from './test-utils/relay-world.js';

const context = { runtimeInstanceId: 'runtime-1', workerVersionId: 'worker-version-1', startReason: 'runtime_start' as const };

/** Answers a Controller's Relay RPCs as an updated Controller would, announcing the diagnostic delivery version it understands, and keeps the diagnostics it receives. */
function collect(socket: Parameters<typeof send>[0], diagnosticVersion = 3) {
  const entries: RelayDiagnostic[] = [];
  const invalid: unknown[] = [];
  socket.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data));
    if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/diagnostics/relay') {
      const batch = parseRelayDiagnosticBatch(JSON.parse(frame.body));
      if (batch) entries.push(...batch); else invalid.push(frame.body);
    }
    send(socket, { type: 'rpc_response', requestId: frame.requestId, status: frame.path === '/remote/controller-update' ? 200 : 204, body: JSON.stringify({ diagnosticDelivery: diagnosticVersion }) });
  });
  return { entries, invalid };
}
const connectedOnce = async (w: Awaited<ReturnType<typeof world>>, version: number) => {
  const alice = await w.signIn('alice');
  const pairing = await (await w.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const first = await w.host(pairing.key);
  const initial = collect(first.socket, version);
  await w.advance(1000);
  const closed = event(first.socket, 'close'); first.socket.close(1000, 'private-close-reason'); await closed;
  const second = await w.host(first.key); const resumed = collect(second.socket, version);
  await w.advance(1000);
  return { initial, resumed, key: second.key };
};

it('delivers the Relay runtime, its close metadata and its start reason, without a private close reason', async () => {
  const w = await world({ diagnosticContext: context });
  const { initial, resumed, key } = await connectedOnce(w, 3);
  expect(initial.entries.find(entry => entry.event === 'host_registered')).toMatchObject({ runtimeInstanceId: 'runtime-1', workerVersionId: 'worker-version-1' });
  expect(resumed.entries.find(entry => entry.event === 'host_disconnected')).toMatchObject({ closeCode: 1000, wasClean: true, reason: 'socket_closed', runtimeInstanceId: 'runtime-1' });
  expect(JSON.stringify(resumed.entries)).not.toContain('private-close-reason');
  await w.restart();
  const restarted = collect((await w.host(key)).socket); await w.advance(1000);
  const start = restarted.entries.find(entry => entry.event === 'relay_started');
  expect(start).toMatchObject({ startReason: 'runtime_start', runtimeInstanceId: 'runtime-1', workerVersionId: 'worker-version-1' });
  expect(start!.relayInstanceId).not.toBe(initial.entries[0]!.relayInstanceId);
  expect([...initial.invalid, ...resumed.invalid, ...restarted.invalid]).toEqual([]);
});

it.each([1, 2])('omits new metadata for diagnostic delivery version %s without stalling batches', async version => {
  const w = await world({ diagnosticContext: context });
  const { initial, resumed } = await connectedOnce(w, version);
  expect(initial.entries.some(entry => entry.event === 'host_registered')).toBe(true);
  expect(resumed.entries.find(entry => entry.event === 'host_disconnected')).toMatchObject({ closeCode: 1000 });
  for (const entry of [...initial.entries, ...resumed.entries]) {
    for (const key of ['wasClean', 'runtimeInstanceId', 'workerVersionId', 'startReason']) expect(entry).not.toHaveProperty(key);
  }
  expect([...initial.invalid, ...resumed.invalid]).toEqual([]);
});
