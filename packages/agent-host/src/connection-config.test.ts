import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveHostConnection, saveRegisteredConnection } from './connection-config.js';

const temporary: string[] = [];

it('retains the local managed marker without copying its LLM credential into connection settings', async () => {
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'device-secret',
    AGENT_HOST_BOOTSTRAP_CODEX: '1', CODEX_GATEWAY_API_KEY: 'must-not-persist-llm-key' });
  await saveRegisteredConnection(path, config, Promise.resolve());
  expect((await resolveHostConnection(path, {})).environment.AGENT_HOST_BOOTSTRAP_CODEX).toBe('1');
  expect(await readFile(join(path, 'connection.json'), 'utf8')).not.toContain('must-not-persist-llm-key');
}, 10000);

it('retains shared Codex connection settings across Host restarts', async () => {
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'device-secret',
    AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_SOCKET: '/tmp/codex.sock', AGENT_HOST_CODEX_TRUST_SHARED: '1' });
  await saveRegisteredConnection(path, config, Promise.resolve({ hostId: 'h1' }));
  expect((await resolveHostConnection(path, {})).environment).toMatchObject({ AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_SOCKET: '/tmp/codex.sock', AGENT_HOST_CODEX_TRUST_SHARED: '1' });
});
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'host-connection-')); temporary.push(path); return path; }
it('saves accepted connection settings privately and restores them without environment settings', async () => {
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'device-secret', AGENT_HOST_PROVIDERS: 'codex,claude', AGENT_HOST_WORKSPACE: '/work', AGENT_HOST_CLAUDE_HOME: '/claude', ANTHROPIC_API_KEY: 'must-not-persist', AGENT_HOST_MANAGEMENT_TOKEN: 'must-not-persist' });
  await saveRegisteredConnection(path, config, Promise.resolve({ hostId: 'h1' }));
  const raw = await readFile(join(path, 'connection.json'), 'utf8');
  expect(raw).toContain('device-secret');
  expect(raw).not.toContain('must-not-persist');
  expect((await stat(join(path, 'connection.json'))).mode & 0o777).toBe(0o600);
  const restored = await resolveHostConnection(path, {});
  expect(restored.serverUrl).toBe('https://relay.example');
  expect(restored.remoteKey).toBe('device-secret');
  expect(restored.environment.AGENT_HOST_PROVIDERS).toBe('codex,claude');
  expect(restored.environment.AGENT_HOST_WORKSPACE).toBe('/work');
  expect(restored.environment.AGENT_HOST_CLAUDE_HOME).toBe('/claude');
});
it('does not store a credential before registration is accepted or replace saved settings after rejection', async () => {
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'original' });
  let accept!: (value: { hostId: string }) => void;
  const pending = saveRegisteredConnection(path, config, new Promise<{ hostId: string }>(resolve => { accept = resolve; }));
  await expect(readFile(join(path, 'connection.json'))).rejects.toThrow();
  accept({ hostId: 'h1' }); await pending;
  const replacement = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://other.example', AGENT_HOST_REMOTE_KEY: 'rejected' });
  await expect(saveRegisteredConnection(path, replacement, Promise.reject(new Error('Denied')))).rejects.toThrow('Denied');
  expect((await resolveHostConnection(path, {})).remoteKey).toBe('original');
});
it('requires the server and credential together for explicit environment overrides', async () => {
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'original' });
  await saveRegisteredConnection(path, config, Promise.resolve({ hostId: 'h1' }));
  await expect(resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://other.example' })).rejects.toThrow(/together/);
  await expect(resolveHostConnection(path, { AGENT_HOST_REMOTE_KEY: 'new' })).rejects.toThrow(/together/);
  const replacement = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://other.example', AGENT_HOST_REMOTE_KEY: 'new', AGENT_HOST_PROVIDERS: 'copilot' });
  await saveRegisteredConnection(path, replacement, Promise.resolve({ hostId: 'h2' }));
  expect((await resolveHostConnection(path, {})).remoteKey).toBe('new');
  expect((await resolveHostConnection(path, {})).environment.AGENT_HOST_PROVIDERS).toBe('copilot');
});

it('persists issued credentials before registration and never overwrites them with the invitation afterward', async () => {
  const { saveIssuedCredential } = await import('./connection-config.js');
  const path = await directory();
  const config = await resolveHostConnection(path, { AGENT_HOST_SERVER: 'https://relay.example', AGENT_HOST_REMOTE_KEY: 'invitation' });
  let accept!: () => void;
  const registering = saveRegisteredConnection(path, config, new Promise<void>(resolve => { accept = resolve; }));
  await saveIssuedCredential(path, config, 'device');
  expect((await resolveHostConnection(path, {})).remoteKey).toBe('device');
  expect(config.remoteKey).toBe('device');
  accept(); await registering;
  expect((await resolveHostConnection(path, {})).remoteKey).toBe('device');
  await Promise.all([saveRegisteredConnection(path, config, Promise.resolve()), saveIssuedCredential(path, config, 'rotated')]);
  expect((await resolveHostConnection(path, {})).remoteKey).toBe('rotated');
});
