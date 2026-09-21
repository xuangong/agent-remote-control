import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configureGatewayProviders } from './gateway-setup.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(providers: string) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-providers-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const apiKey = 'test-gateway-token-1234567890';
  const server = createServer((request, response) => {
    request.resume(); requests++;
    expect(request.headers.authorization).toBe('Bearer device-test');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ apiKey, keyId: 'key-host', baseUrl: 'https://gateway.example/v1', model: 'gateway-model' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
  return { root, apiKey, get requests() { return requests; }, connection: { serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: 'device-test', environment: { AGENT_HOST_PROVIDERS: providers } } };
}
it('initializes only selected Claude with a private home and no Codex configuration', async () => {
  const f = await fixture('claude');
  const env = await configureGatewayProviders(f.root, f.connection, 'host-test');
  expect(env).toMatchObject({ AGENT_HOST_CLAUDE_HOME: join(f.root, 'gateway-claude'), ANTHROPIC_API_KEY: f.apiKey,
    ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_MODEL: 'gateway-model' });
  expect(env.CODEX_HOME).toBeUndefined();
  await expect(readFile(join(f.root, 'gateway-codex', 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(join(f.root, 'gateway-claude', 'gateway-credentials.json'))).mode & 0o777).toBe(0o600);
  expect(f.requests).toBe(1);
}, 10000);
it('shares one bootstrap response across selected Codex and Claude and preserves native Claude settings', async () => {
  const f = await fixture('codex,claude');
  const env = await configureGatewayProviders(f.root, f.connection, 'host-test');
  expect(env.CODEX_GATEWAY_API_KEY).toBe(f.apiKey); expect(env.ANTHROPIC_API_KEY).toBe(f.apiKey);
  expect(f.requests).toBe(1);
  const settings = join(f.root, 'gateway-claude', 'settings.json');
  await writeFile(settings, '{"permissions":{"allow":["Read"]}}\n');
  await configureGatewayProviders(f.root, f.connection, 'host-test');
  expect(await readFile(settings, 'utf8')).toBe('{"permissions":{"allow":["Read"]}}\n');
}, 10000);
it('rejects unsupported selected providers before requesting a token', async () => {
  const f = await fixture('codex,copilot');
  await expect(configureGatewayProviders(f.root, f.connection, 'host-test')).rejects.toThrow(/copilot.*not supported/i);
  expect(f.requests).toBe(0);
}, 10000);
it('rejects personal Claude home overrides before requesting a token', async () => {
  const f = await fixture('claude');
  await expect(configureGatewayProviders(f.root, { ...f.connection, environment: { ...f.connection.environment, AGENT_HOST_CLAUDE_HOME: '/personal/claude' } }, 'host-test')).rejects.toThrow(/dedicated/i);
  expect(f.requests).toBe(0);
}, 10000);
