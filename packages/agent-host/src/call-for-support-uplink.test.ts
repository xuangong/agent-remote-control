import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createAgentHost, type AgentHostDirectory } from './host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const registration = (providerId: string, readOnly: boolean) => ({
  directory: { providerId, list: async () => [], workspaces: async () => [], create: async () => { throw new Error('Unused.'); }, open: async () => { throw new Error('Unused.'); } } satisfies AgentHostDirectory,
  adapter: { descriptor: { providerId, displayName: providerId, ...(readOnly ? { sessionAccess: { readOnly: true as const } } : {}) },
    createSession: async () => { throw new Error('Unused.'); }, resumeSession: async () => { throw new Error('Unused.'); } },
});

it('names read-only providers with the Call For Support request and keeps them out of the provider descriptors', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const connected = new Promise<{ url: URL; register: { providers: unknown[] } }>(resolve => server.on('connection', (socket, request) => socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'register') resolve({ url: new URL(request.url!, 'http://localhost'), register: message });
  })));
  const root = await mkdtemp(join(tmpdir(), 'cfs-uplink-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const host = createAgentHost({ installationId: 'cfs-uplink', name: 'Host', registrations: [registration('codex', true), registration('opencode', false)],
    team: { stateDirectory: root }, uplink: { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, remoteKey: 'key' } });
  cleanup.push(() => host.close());
  const { url, register } = await connected;
  expect(url.searchParams.get('callForSupport')).toBe('1');
  expect(url.searchParams.getAll('readOnlyProvider')).toEqual(['codex']);
  // Relays before Call For Support validate provider descriptors strictly, so they carry no new field.
  expect(register.providers).toEqual([{ providerId: 'codex', displayName: 'codex' }, { providerId: 'opencode', displayName: 'opencode' }]);
});
