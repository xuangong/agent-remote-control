// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { createRemoteHostBroker } from './remote-host-broker.js';

const work = { id: 'work-one', revision: 1, title: 'Delivery', providerId: 'codex', mainNativeSessionId: 'main-one', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09', updatedAt: '2026-10-09', nextCheckAt: 0 };
const operationId = '00000000-0000-4000-8000-000000000001';
it('forwards TPM requests through one authorized Host uplink and preserves mutation identities', async () => {
  const server = createServer();
  let subject = 'alice';
  let revokeOnReply = false, invalidReply = false;
  const broker = createRemoteHostBroker({ origin: 'http://127.0.0.1:6175', ownerSubject: 'alice', principalSubject: () => subject });
  broker.install(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body?: object, origin?: string) => fetch(base + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(3000),
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const calls: any[] = [];
  let socket: WebSocket | undefined;
  try {
    const { key } = await (await request('/v1/remote/pairings', {})).json();
    socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
    await once(socket, 'open'); const registered = once(socket, 'message');
    socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', tpmManagement: true, installationId: 'tpm-transport-test', name: 'TPM Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    const [raw] = await registered; const { hostId } = JSON.parse(raw.toString());
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); if (frame.type !== 'rpc_request') return;
      calls.push(frame);
      if (revokeOnReply) subject = 'bob';
      socket!.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify(invalidReply ? { ...work, id: 'another-work' } : frame.method === 'GET' && frame.path === '/remote/tpm' ? { supported: true, works: [] } : { ...work, id: frame.path.includes('work?') ? 'work/one' : work.id }) }));
    });
    const path = `/v1/remote/hosts/${hostId}/tpm`;
    expect((await request(path)).status).toBe(200);
    const create = { providerId: 'codex', mainNativeSessionId: 'main-one', title: 'Delivery', requirement: 'Ship it', operationId };
    expect((await request(path + '/create', create)).status).toBe(200);
    expect((await request(path + '/work?id=work%2Fone')).status).toBe(200);
    const action = { id: 'work-one', action: 'pause', revision: 1, operationId };
    expect((await request(path + '/action', action)).status).toBe(200);
    expect(calls.map(frame => ({ method: frame.method, path: frame.path, ...(frame.body ? { body: JSON.parse(frame.body) } : {}) }))).toEqual([
      { method: 'GET', path: '/remote/tpm' }, { method: 'POST', path: '/remote/tpm/create', body: create },
      { method: 'GET', path: '/remote/tpm/work?id=work%2Fone' }, { method: 'POST', path: '/remote/tpm/action', body: action },
    ]);
    const confirmation = { ...action, action: 'confirm_todo', confirmation: { revision: 7, stepId: 'agree', requestId: 'request-7', decision: 'approve' } };
    expect((await request(path + '/action', confirmation)).status).toBe(200);
    expect(JSON.parse(calls.at(-1).body)).toEqual(confirmation);
    expect((await request(path + '/action', { ...confirmation, confirmation: { ...confirmation.confirmation, decision: 'auto' } })).status).toBe(400);
    expect((await request(path + '/action', confirmation, 'https://foreign.example')).status).toBe(403);
    expect(calls.every(frame => frame.sessionId === undefined)).toBe(true);
    expect((await request(path + '/create', { ...create, executable: '/bin/sh' })).status).toBe(400);
    expect((await request(path + '/action', { ...action, revision: -1 })).status).toBe(400);
    expect((await request(path + '/action', { ...action, action: 'cancel' })).status).toBe(400);
    expect((await request(path + '/action', action, 'https://foreign.example')).status).toBe(403);
    expect((await request(path + '/work?id=work-one&target=other')).status).toBe(400);
    expect(calls).toHaveLength(5);
    invalidReply = true;
    expect((await request(path + '/action', action)).status).toBe(502);
    invalidReply = false; revokeOnReply = true;
    expect((await request(path)).status).toBe(403);
    expect(calls).toHaveLength(7);
  } finally {
    socket?.terminate(); await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
