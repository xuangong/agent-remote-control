import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGatewayCodex, loadGatewayCodexEnvironment, managedCodexHome } from './gateway-codex.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(status = 200, value: unknown = { apiKey: 'test-only-gateway-token-1234567890', keyId: 'key-one', baseUrl: 'https://gateway.example/v1', model: 'test-model' }) {
  const root = await mkdtemp(join(tmpdir(), 'arc-gateway-codex-')); roots.push(root);
  const requests: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const connection = { serverUrl: `http://127.0.0.1:${address.port}`, remoteKey: 'device-test-key', environment: {} };
  return { root, requests, connection, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
it('configures a private managed Codex home from authenticated HTTP and restores it after restart', async () => {
  const f = await fixture();
  try {
    const env = await configureGatewayCodex(f.root, f.connection, 'host-one');
    const home = managedCodexHome(f.root, {});
    expect(env).toMatchObject({ CODEX_HOME: home, AGENT_REMOTE_CODEX_HOME: home, AGENT_HOST_CODEX_CONNECTION: 'private', LC_ALL: 'C', CODEX_GATEWAY_API_KEY: 'test-only-gateway-token-1234567890' });
    expect(f.requests).toEqual([{ url: '/v1/remote/host/bootstrap', authorization: 'Bearer device-test-key' }]);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('env_key = "CODEX_GATEWAY_API_KEY"');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('test-only-gateway-token');
    expect((await stat(join(home, 'gateway-credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(await loadGatewayCodexEnvironment(f.root, { AGENT_HOST_BOOTSTRAP_CODEX: '1' })).toMatchObject(env);
    await configureGatewayCodex(f.root, f.connection, 'host-one');
    await writeFile(join(home, 'config.toml'), '# User changes\n');
    await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow(/modified/);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('# User changes\n');
  } finally { await f.close(); }
});
it('does not overwrite existing unmanaged configuration or accept a different native home', async () => {
  const f = await fixture();
  try {
    expect(() => managedCodexHome(f.root, { CODEX_HOME: '/user/codex' })).toThrow(/dedicated/);
    const home = managedCodexHome(f.root, {}); await mkdir(home); await writeFile(join(home, 'config.toml'), '# Personal config\n');
    await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow(/unmanaged/);
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});
it.each([401, 403, 409, 503])('fails closed without exposing response secrets for HTTP %s', async status => {
  const f = await fixture(status, { error: 'secret-value-do-not-log' });
  try {
    await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow(`HTTP ${status}`);
    await expect(readFile(join(f.root, 'gateway-codex', 'gateway-credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
});
it('rejects credential injection', async () => {
  const f = await fixture(200, { apiKey: 'secret\nINJECT=1', keyId: 'k', model: 'test', baseUrl: 'https://gateway.example/v1' });
  try { await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow(/invalid/); }
  finally { await f.close(); }
});
it('repairs an interrupted update while still rejecting unrelated config changes', async () => {
  const f = await fixture();
  try {
    await configureGatewayCodex(f.root, f.connection, 'host-one');
    const home = managedCodexHome(f.root, {});
    const path = join(home, 'gateway-credentials.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, model: 'new-model', previousManagedConfig: await readFile(join(home, 'config.toml'), 'utf8') }));
    await configureGatewayCodex(f.root, f.connection, 'host-one');
    expect(JSON.parse(await readFile(path, 'utf8')).previousManagedConfig).toBeUndefined();
    await expect(configureGatewayCodex(f.root, f.connection, 'other-host')).rejects.toThrow(/another Host/);
  } finally { await f.close(); }
});
it('rejects redirects without forwarding device credentials', async () => {
  const f = await fixture(302);
  try {
    await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow('HTTP 302');
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});
it('preserves native project trust settings across bootstrap and protects managed provider fields', async () => {
  const f = await fixture();
  try {
    await configureGatewayCodex(f.root, f.connection, 'host-one');
    const path = join(managedCodexHome(f.root, {}), 'config.toml');
    const original = await readFile(path, 'utf8');
    const project = '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
    await writeFile(path, original + project);
    await configureGatewayCodex(f.root, f.connection, 'host-one');
    expect(await readFile(path, 'utf8')).toBe(original + project);
    await writeFile(path, original.replace('agent_gateway', 'personal_provider') + project);
    await expect(configureGatewayCodex(f.root, f.connection, 'host-one')).rejects.toThrow(/modified/);
  } finally { await f.close(); }
});
