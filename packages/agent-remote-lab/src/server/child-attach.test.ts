// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import type { AgentSession } from '@borgee/agent-provider-sdk';
import { createProtocolValidationServer } from '../server.js';
import { createRecordedLabProvider } from './recorded.js';
import type { SessionDirectorySource } from './session-directory.js';

const servers: ReturnType<typeof createProtocolValidationServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function fixture(supported = true) {
  const { provider } = createRecordedLabProvider();
  const opened = new Map<string, AgentSession>();
  const calls: string[][] = [];
  const child = { nativeSessionId: 'child', title: 'Review', createdAt: '2026-09-10T00:00:00.000Z', status: 'idle' as const, observation: 'live' as const };
  const source: SessionDirectorySource = {
    providerId: 'recorded',
    list: () => ['parent', 'other'].map((nativeSessionId) => ({ nativeSessionId, providerId: 'recorded', title: nativeSessionId, createdAt: child.createdAt, updatedAt: child.createdAt, state: 'idle' as const })),
    workspaces: () => [],
    create: async () => 'parent',
    async open(id) {
      const session = await provider.createSession({ sessionId: id });
      const runtime = session.runtimeInfo.bind(session);
      session.runtimeInfo = async () => ({ ...await runtime(), childSessions: id === 'parent' ? [child] : [] });
      opened.set(id, session);
      return session;
    },
    ...(supported ? { async openChild(parentId: string, id: string) {
      calls.push([parentId, id]);
      if (parentId !== 'parent' || id !== 'child') throw new Error('Not a direct child');
      return provider.createSession({ sessionId: id });
    } } : {}),
  };
  const server = createProtocolValidationServer({ providers: [provider], directories: [source], labOrigin: 'http://127.0.0.1:5175' });
  servers.push(server);
  const { url } = await server.http.listen();
  const post = (path: string, body: unknown, origin?: string) => fetch(`${url}/v1/remote/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  return { server, post, calls, url };
}
const request = { providerId: 'recorded', parentNativeSessionId: 'parent', nativeSessionId: 'child' };

it('attaches a discovered child once and leaves it out of the root catalog', async () => {
  const f = await fixture();
  await f.post('attach', { providerId: 'recorded', nativeSessionId: 'parent' });
  const [a, b] = await Promise.all([f.post('child/attach', request), f.post('child/attach', request)]);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  const one = await a.json(); expect(await b.json()).toEqual(one);
  expect(f.calls).toEqual([['parent', 'child']]);
  expect(f.server.relay.requireAgent(one.agentId).snapshot().payload.runtimeInfo.sessionId).toBe('child');
  const roots = await (await fetch(`${f.url}/v1/remote/catalog?providerId=recorded`)).json();
  expect(roots.items.map((item: { nativeSessionId: string }) => item.nativeSessionId).sort()).toEqual(['other', 'parent']);
});

it('checks loaded parent ownership before using cached child attachments', async () => {
  const f = await fixture();
  expect((await f.post('child/attach', request)).status).toBe(409);
  await f.post('attach', { providerId: 'recorded', nativeSessionId: 'parent' });
  await f.post('attach', { providerId: 'recorded', nativeSessionId: 'other' });
  expect((await f.post('child/attach', request)).status).toBe(200);
  expect((await f.post('child/attach', { ...request, parentNativeSessionId: 'other' })).status).toBe(404);
  expect((await f.post('child/attach', { ...request, nativeSessionId: 'missing' })).status).toBe(404);
  expect(f.calls).toHaveLength(1);
});

it('rejects unsupported sources and cross-origin requests without opening a native child', async () => {
  const f = await fixture(false);
  await f.post('attach', { providerId: 'recorded', nativeSessionId: 'parent' });
  expect((await f.post('child/attach', request)).status).toBe(409);
  expect((await f.post('child/attach', request, 'https://other.example')).status).toBe(403);
  expect(f.calls).toEqual([]);
});
