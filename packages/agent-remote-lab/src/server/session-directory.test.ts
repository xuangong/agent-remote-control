// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { createProtocolValidationServer } from '../server.js';
import { createSessionDirectory } from './session-directory.js';
import type { AgentProviderAdapter } from '@agent-remote-controller/agent-provider-sdk';
import { createRecordedLabProvider } from './recorded.js';

const servers: ReturnType<typeof createProtocolValidationServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function start() {
  const { provider } = createRecordedLabProvider();
  const server = createProtocolValidationServer({ providers: [provider], labOrigin: 'http://127.0.0.1:5175' });
  servers.push(server);
  const { url } = await server.http.listen();
  const get = async (path: string) => fetch(`${url}/v1/remote/${path}`);
  const post = async (path: string, body: unknown, origin?: string) => fetch(`${url}/v1/remote/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  return { server, get, post };
}

it('discovers a recorded session and deduplicates concurrent attachment', async () => {
  const { get, post, server } = await start();
  const response = await get('catalog?providerId=recorded');
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.items).toHaveLength(1);
  const body = { providerId: 'recorded', nativeSessionId: page.items[0].nativeSessionId };
  const opened = await Promise.all([post('attach', body), post('attach', body)]);
  const [one, two] = await Promise.all(opened.map((result) => result.json()));
  expect(one.agentId).toBeTypeOf('string');
  expect(two.agentId).toBe(one.agentId);
  expect(server.relay.requireAgent(one.agentId).snapshot().payload.id).toBe(one.agentId);
});

it('creates once for a request identity and immediately adds the session to discovery', async () => {
  const { get, post } = await start();
  const body = { providerId: 'recorded', operationId: '00000000-0000-4000-8000-000000000001', cwd: '/tmp/remote-workspace' };
  const results = await Promise.all([post('create', body), post('create', body)]);
  const [one, two] = await Promise.all(results.map((result) => result.json()));
  expect(one.agentId).toBeTypeOf('string');
  expect(two.agentId).toBe(one.agentId);
  const page = await (await get('catalog?providerId=recorded')).json();
  expect(page.items).toHaveLength(2);
  expect(page.items.some((item: {workspace: string}) => item.workspace === '/tmp/remote-workspace')).toBe(true);
  const conflict = await post('create', { ...body, cwd: '/another/path' });
  expect(conflict.status).toBe(409);
});

it('rejects cross-origin mutations and unknown sessions', async () => {
  const { get, post } = await start();
  expect((await post('create', { providerId: 'recorded', operationId: '00000000-0000-4000-8000-000000000002' }, 'https://other.example')).status).toBe(403);
  expect((await post('attach', { providerId: 'recorded', nativeSessionId: 'missing' })).status).toBe(404);
  expect((await get('catalog?providerId=missing')).status).toBe(404);
  expect((await get('catalog?providerId=recorded&limit=0')).status).toBe(400);
});

it('reopens after a Relay session is released', async () => {
  const { post, server } = await start();
  const body = { providerId: 'recorded', nativeSessionId: 'recorded-welcome' };
  const first = await (await post('attach', body)).json();
  await server.relay.closeAgent(first.agentId);
  const second = await (await post('attach', body)).json();
  expect(second.agentId).toBeTypeOf('string');
  expect(second.agentId).not.toBe(first.agentId);
});

it('preserves Provider prototype methods when adding directory attachment', async () => {
  const { provider } = createRecordedLabProvider();
  class ClassProvider implements AgentProviderAdapter {
    get descriptor() { return provider.descriptor; }
    createSession: AgentProviderAdapter['createSession'] = (config) => provider.createSession(config);
    resumeSession(handle: Parameters<AgentProviderAdapter['resumeSession']>[0]) { return provider.resumeSession(handle); }
  }
  const directory = createSessionDirectory([new ClassProvider()]);
  const resumed = await directory.providers[0]!.resumeSession({ providerId: 'recorded', sessionId: 'prototype', opaque: 'recorded:prototype' });
  expect(resumed.capabilities.sendMessage).toBe(true);
  await resumed.dispose(); directory.close();
});
