import type { WebSocket } from 'miniflare';
import { expect, it } from 'vitest';
import { parseRelayDiagnosticBatch, type RelayDiagnostic } from '../../agent-remote-hosted/src/relay-diagnostics.js';
import { event, fixture, send } from './fixture.js';

function collect(socket: WebSocket, diagnosticVersion = 3) {
  const entries: RelayDiagnostic[] = [];
  const invalid: unknown[] = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'rpc_request') return;
    if (frame.path === '/remote/diagnostics/relay') {
      const batch = parseRelayDiagnosticBatch(JSON.parse(frame.body));
      if (batch) entries.push(...batch); else invalid.push(frame.body);
    }
    send(socket, { type: 'rpc_response', requestId: frame.requestId,
      status: frame.path === '/remote/controller-update' ? 200 : 204, body: JSON.stringify({ diagnosticDelivery: diagnosticVersion }) });
  });
  return { entries, invalid };
}

it('delivers Worker close metadata and distinguishes object startup from core recovery', async () => {
  const f = await fixture({ workerVersionId: 'worker-version-1' });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const first = await f.host(pairing.key);
  const initial = collect(first.socket);
  await expect.poll(() => initial.entries.find(entry => entry.event === 'host_registered'), { timeout: 5000 }).toMatchObject({
    runtimeInstanceId: expect.any(String), workerVersionId: 'worker-version-1',
  });
  const original = initial.entries.find(entry => entry.event === 'host_registered')!;
  const closed = event(first.socket, 'close'); first.socket.close(1000, 'private-close-reason'); await closed;
  const second = await f.host(first.key); const reconnected = collect(second.socket);
  await expect.poll(() => reconnected.entries.find(entry => entry.event === 'host_disconnected'), { timeout: 5000 }).toMatchObject({
    closeCode: 1000, wasClean: true, reason: 'socket_closed', runtimeInstanceId: original.runtimeInstanceId,
  });
  expect(JSON.stringify(reconnected.entries)).not.toContain('private-close-reason');
  await f.restart();
  const third = await f.host(second.key); const restarted = collect(third.socket);
  await expect.poll(() => restarted.entries.find(entry => entry.event === 'relay_started'), { timeout: 5000 }).toMatchObject({
    startReason: 'runtime_start', workerVersionId: 'worker-version-1', runtimeInstanceId: expect.any(String),
  });
  const start = restarted.entries.find(entry => entry.event === 'relay_started')!;
  expect(start.runtimeInstanceId).not.toBe(original.runtimeInstanceId);
  expect(start.relayInstanceId).not.toBe(original.relayInstanceId);
  await f.inspect('fail-commit');
  expect((await f.request('/auth/login')).status).toBe(503);
  await f.inspect('restore-commit'); await f.inspect('alarm');
  const fourth = await f.host(third.key); const recovered = collect(fourth.socket);
  await expect.poll(() => recovered.entries.find(entry => entry.event === 'relay_started'), { timeout: 5000 }).toMatchObject({
    startReason: 'core_recovery', runtimeInstanceId: start.runtimeInstanceId, workerVersionId: 'worker-version-1',
  });
  expect(recovered.entries.find(entry => entry.event === 'relay_started')!.relayInstanceId).not.toBe(start.relayInstanceId);
  expect([...initial.invalid, ...reconnected.invalid, ...restarted.invalid, ...recovered.invalid]).toEqual([]);
}, 20000);

it.each([1, 2])('omits new metadata for diagnostic delivery version %s without stalling batches', async version => {
  const f = await fixture({ workerVersionId: 'worker-version-1' });
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const first = await f.host(pairing.key);
  const initial = collect(first.socket, version);
  await expect.poll(() => initial.entries.some(entry => entry.event === 'host_registered'), { timeout: 5000 }).toBe(true);
  const closed = event(first.socket, 'close'); first.socket.close(1000); await closed;
  const second = await f.host(first.key); const resumed = collect(second.socket, version);
  await expect.poll(() => resumed.entries.find(entry => entry.event === 'host_disconnected'), { timeout: 5000 }).toMatchObject({ closeCode: 1000 });
  for (const entry of [...initial.entries, ...resumed.entries]) {
    for (const key of ['wasClean', 'runtimeInstanceId', 'workerVersionId', 'startReason']) expect(entry).not.toHaveProperty(key);
  }
  expect([...initial.invalid, ...resumed.invalid]).toEqual([]);
}, 10000);
