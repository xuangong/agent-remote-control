import { expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';
import type { AgentRemoteRelay } from '../relay.js';

async function server(onConnection: (socket: WebSocket, authorization: string) => void) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => wss.once('listening', resolve));
  wss.on('connection', (socket, req) => onConnection(socket, req.headers.authorization ?? ''));
  const address = wss.address(); if (typeof address === 'string') throw new Error('Unexpected address');
  return { url: `ws://127.0.0.1:${address.port}/ws/remote-host`, close: async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  } };
}
function send(socket: WebSocket, message: Record<string, unknown>) { socket.send(JSON.stringify({ uplinkVersion: 2, ...message })); }
const base = { relay: {} as AgentRemoteRelay, installationId: 'install', name: 'Host', remoteKey: 'invitation', resolveSession: () => undefined,
  control: () => ({ status: 200, body: '{}' }), reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 10 };

it('advertises durable credentials only with a callback and acknowledges after persistence completes', async () => {
  let save!: () => void; let offered = ''; let acknowledged = false; let advertised: unknown;
  const relay = await server(socket => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'register') { advertised = message.credentialRotation; send(socket, { type: 'credential_issued', credential: 'device' }); }
    if (message.type === 'credential_saved') { acknowledged = true; send(socket, { type: 'registered', hostId: 'host' }); }
  }));
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url, onCredential: async credential => { offered = credential; await new Promise<void>(resolve => { save = resolve; }); } });
  try {
    await expect.poll(() => offered).toBe('device'); expect(advertised).toBe(true); expect(acknowledged).toBe(false);
    save(); expect(await client.ready).toEqual({ hostId: 'host' }); expect(acknowledged).toBe(true);
  } finally { save?.(); await client.close(); await relay.close(); }
});
it('reconnects with a saved offered credential when the enrollment acknowledgment is dropped', async () => {
  const authorizations: string[] = []; let saved = '';
  const relay = await server((socket, authorization) => {
    authorizations.push(authorization);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') {
        if (authorizations.length === 1) send(socket, { type: 'credential_issued', credential: 'rotated-device' });
        else send(socket, { type: 'registered', hostId: 'host' });
      }
      if (message.type === 'credential_saved') socket.terminate();
    });
  });
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url, onCredential: async credential => { saved = credential; } });
  try { await client.ready; expect(saved).toBe('rotated-device'); expect(authorizations.slice(0, 2)).toEqual(['Bearer invitation', 'Bearer rotated-device']); }
  finally { await client.close(); await relay.close(); }
});
it('accepts later rotation after registration and refuses to acknowledge a failed durable save', async () => {
  let socket!: WebSocket; let acknowledgments = 0;
  const relay = await server(value => { socket = value; value.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'register') send(value, { type: 'registered', hostId: 'host' });
    if (message.type === 'credential_saved') acknowledgments++;
  }); });
  const states: string[] = [];
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url, onStateChange: state => states.push(state),
    onCredential: async () => { throw new Error('disk failed with secret'); } });
  try { await client.ready; send(socket, { type: 'credential_issued', credential: 'rotated-device' });
    await expect.poll(() => states.includes('rejected')).toBe(true); expect(acknowledgments).toBe(0); }
  finally { await client.close(); await relay.close(); }
});
it('keeps legacy hosts registered without advertising credential rotation', async () => {
  let advertised: unknown = 'unseen';
  const relay = await server(socket => socket.on('message', data => { const message = JSON.parse(data.toString());
    if (message.type === 'register') { advertised = message.credentialRotation; send(socket, { type: 'registered', hostId: 'host' }); }
  }));
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url });
  try { await client.ready; expect(advertised).toBeUndefined(); } finally { await client.close(); await relay.close(); }
});
it('waits for an in-flight durable write before reconnecting a disconnected enrollment', async () => {
  const authorizations: string[] = []; let persist!: () => void; let entered = false;
  const relay = await server((socket, authorization) => {
    authorizations.push(authorization);
    socket.on('message', data => { if (JSON.parse(data.toString()).type !== 'register') return;
      if (authorizations.length === 1) send(socket, { type: 'credential_issued', credential: 'saved-after-disconnect' });
      else send(socket, { type: 'registered', hostId: 'host' });
    });
    if (authorizations.length === 1) void (async () => {
      await expect.poll(() => entered).toBe(true); socket.terminate();
    })();
  });
  const states: string[] = [];
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url, onStateChange: state => states.push(state), onCredential: async () => {
    entered = true; await new Promise<void>(resolve => { persist = resolve; });
  } });
  try {
    await expect.poll(() => states.includes('disconnected')).toBe(true);
    expect(authorizations).toEqual(['Bearer invitation']); persist(); await client.ready;
    expect(authorizations).toEqual(['Bearer invitation', 'Bearer saved-after-disconnect']);
  } finally { persist?.(); await client.close(); await relay.close(); }
});
it('rotates an already registered host and reconnects with the rotated credential', async () => {
  const authorizations: string[] = []; let saved = '';
  const relay = await server((socket, authorization) => {
    authorizations.push(authorization);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') {
        send(socket, { type: 'registered', hostId: 'host' });
        if (authorizations.length === 1) send(socket, { type: 'credential_issued', credential: 'next-device' });
      }
      if (message.type === 'credential_saved') socket.terminate();
    });
  });
  const client = createRemoteHostUplinkClient({ ...base, url: relay.url, onCredential: async credential => { saved = credential; } });
  try { await client.ready; await expect.poll(() => authorizations.length).toBe(2);
    expect(authorizations).toEqual(['Bearer invitation', 'Bearer next-device']); expect(saved).toBe('next-device'); }
  finally { await client.close(); await relay.close(); }
});
