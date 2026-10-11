import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostProviderDiscovery } from './provider-discovery.js';
import { OpenCodeServerError } from './opencode-server.js';
import type { AgentHostProviderRegistration } from './host.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'arc-provider-discovery-')); roots.push(value); return value; }
const registration = (providerId: string): AgentHostProviderRegistration => ({ adapter: { descriptor: { providerId, displayName: providerId }, createSession: vi.fn(), resumeSession: vi.fn() }, directory: { providerId, list: () => [], workspaces: () => [], create: vi.fn(), open: vi.fn(), close: vi.fn() } });
it('discovers every supported provider despite an old saved codex selection and isolates failures', async () => {
  const create = vi.fn(async (id: string) => { if (id === 'claude') throw new Error('secret'); return registration(id); });
  const manager = await createHostProviderDiscovery({ stateDir: await root(), env: { AGENT_HOST_PROVIDERS: 'codex' }, create });
  expect(create.mock.calls.map(([id]) => id)).toEqual(['codex', 'claude', 'copilot', 'opencode']);
  expect(manager.snapshot().providers.map(item => item.state)).toEqual(['enabled', 'unavailable', 'enabled', 'enabled']);
  expect(JSON.stringify(manager.snapshot())).not.toContain('secret'); await manager.stop();
});
it('persists disabled preferences, rejects stale writes and never closes an active registration', async () => {
  const stateDir = await root(); const create = vi.fn(async (id: string) => registration(id));
  const manager = await createHostProviderDiscovery({ stateDir, env: {}, create });
  const revision = manager.snapshot().revision;
  const request = { method: 'POST' as const, path: '/remote/provider-settings', body: JSON.stringify({ providerId: 'codex', enabled: false, revision }) };
  expect((await manager.control(request)).status).toBe(200); expect(manager.enabled('codex')).toBe(false);
  expect(manager.registrations[0]!.directory.close).not.toHaveBeenCalled();
  expect((await manager.control(request)).status).toBe(409);
  expect(JSON.parse(await readFile(join(stateDir, 'provider-settings.json'), 'utf8')).disabled).toEqual(['codex']);
  await manager.stop(); create.mockClear();
  const restarted = await createHostProviderDiscovery({ stateDir, env: {}, create });
  expect(create.mock.calls.map(([id]) => id)).not.toContain('codex'); expect(restarted.snapshot().providers[0]?.state).toBe('disabled'); await restarted.stop();
});
it('adds a newly installed provider without duplicate registrations or unchanged revisions', async () => {
  let installed = false;
  const manager = await createHostProviderDiscovery({ stateDir: await root(), env: {}, create: async id => {
    if (id === 'opencode' && !installed) throw new Error('missing'); return registration(id);
  } });
  const added = vi.fn(), updated = vi.fn(); manager.onRegistration(added); manager.subscribe(updated);
  const revision = manager.snapshot().revision; await manager.refresh(); expect(manager.snapshot().revision).toBe(revision);
  installed = true; await manager.refresh(); await manager.refresh();
  expect(added).toHaveBeenCalledTimes(1); expect(updated).toHaveBeenCalledTimes(1); expect(manager.registrations).toHaveLength(4); await manager.stop();
});
it('stays manageable with no native providers and preserves unknown disabled IDs', async () => {
  const stateDir = await root(); await writeFile(join(stateDir, 'provider-settings.json'), JSON.stringify({ disabled: ['future-agent'] }));
  const manager = await createHostProviderDiscovery({ stateDir, env: {}, create: async () => { throw new Error('not installed'); } });
  expect(manager.registrations).toEqual([]);
  await manager.control({ method: 'POST', path: '/remote/provider-settings', body: JSON.stringify({ providerId: 'claude', enabled: false, revision: manager.snapshot().revision }) });
  expect(JSON.parse(await readFile(join(stateDir, 'provider-settings.json'), 'utf8')).disabled).toEqual(['future-agent', 'claude']); await manager.stop();
});
it('fails closed instead of discarding unreadable preferences', async () => {
  const stateDir = await root(); await writeFile(join(stateDir, 'provider-settings.json'), '{bad');
  await expect(createHostProviderDiscovery({ stateDir, env: {}, create: vi.fn() })).rejects.toThrow('refusing to discard');
});

it('recovers an existing OpenCode registration after native failure without replacing active sessions', async () => {
  let nativeReady = true;
  const prepare = vi.fn(async () => {
    if (!nativeReady) throw new OpenCodeServerError('opencode_health_unreachable', 'The managed OpenCode process is still running but is not healthy.');
  });
  const create = vi.fn(async (id: string) => registration(id));
  const diagnostic = vi.fn();
  const manager = await createHostProviderDiscovery({ stateDir: await root(), env: {}, create, prepare, onDiagnostic: diagnostic });
  const existing = manager.registrations.find(item => item.directory.providerId === 'opencode')!;
  const added = vi.fn(), updated = vi.fn(); manager.onRegistration(added); manager.subscribe(updated);
  expect(manager.enabled('opencode')).toBe(true);

  nativeReady = false; await manager.refresh();
  expect(manager.enabled('opencode')).toBe(false);
  expect(manager.snapshot().providers.find(item => item.providerId === 'opencode')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('not healthy') });
  expect(diagnostic.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({ providerId: 'opencode', outcome: 'unavailable', code: 'opencode_health_unreachable' }));
  expect(manager.registrations.find(item => item.directory.providerId === 'opencode')).toBe(existing);
  expect(existing.directory.close).not.toHaveBeenCalled();

  nativeReady = true; await manager.refresh();
  expect(manager.enabled('opencode')).toBe(true);
  expect(manager.registrations.find(item => item.directory.providerId === 'opencode')).toBe(existing);
  expect(create.mock.calls.filter(([id]) => id === 'opencode')).toHaveLength(1);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(added).not.toHaveBeenCalled(); expect(updated).toHaveBeenCalledTimes(2);
  await manager.stop();
});

it('never prepares disabled OpenCode and resumes maintenance when enabled again', async () => {
  const stateDir = await root();
  await writeFile(join(stateDir, 'provider-settings.json'), JSON.stringify({ disabled: ['opencode'] }));
  const prepare = vi.fn(async () => {}), create = vi.fn(async (id: string) => registration(id));
  const manager = await createHostProviderDiscovery({ stateDir, env: {}, create, prepare });
  await manager.refresh();
  expect(prepare).not.toHaveBeenCalled(); expect(manager.enabled('opencode')).toBe(false);
  expect(create.mock.calls.map(([id]) => id)).not.toContain('opencode');

  expect((await manager.control({ method: 'POST', path: '/remote/provider-settings',
    body: JSON.stringify({ providerId: 'opencode', enabled: true, revision: manager.snapshot().revision }) })).status).toBe(200);
  expect(manager.enabled('opencode')).toBe(true); expect(prepare).toHaveBeenCalledTimes(1);
  const existing = manager.registrations.find(item => item.directory.providerId === 'opencode')!;
  await manager.control({ method: 'POST', path: '/remote/provider-settings',
    body: JSON.stringify({ providerId: 'opencode', enabled: false, revision: manager.snapshot().revision }) });
  await manager.refresh();
  expect(manager.enabled('opencode')).toBe(false); expect(prepare).toHaveBeenCalledTimes(1);
  expect(existing.directory.close).not.toHaveBeenCalled(); await manager.stop();
});

it.each([
  { env: { AGENT_HOST_OPENCODE_TRUST_SHARED: '0' }, allowed: false },
  { env: { AGENT_HOST_OPENCODE_TRUST_SHARED: '0', AGENT_HOST_TRUSTED_FULL_CONTROL: '1' }, allowed: true },
  { env: { AGENT_HOST_OPENCODE_TRUST_SHARED: '1' }, allowed: true },
  { env: {}, allowed: true },
])('checks shared execution policy before starting OpenCode: $env', async ({ env, allowed }) => {
  const prepare = vi.fn(async () => {}), create = vi.fn(async (id: string) => registration(id));
  const manager = await createHostProviderDiscovery({ stateDir: await root(), env, create, prepare });
  expect(manager.enabled('opencode')).toBe(allowed);
  expect(prepare).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(create.mock.calls.some(([id]) => id === 'opencode')).toBe(allowed);
  if (!allowed) expect(manager.snapshot().providers.find(item => item.providerId === 'opencode')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('permissions') });
  await manager.stop();
});

it('publishes safe OpenCode lifecycle changes while withholding arbitrary preparation errors', async () => {
  let failure: Error = new OpenCodeServerError('opencode_cli_unavailable', 'The Controller could not run OpenCode CLI.');
  const prepare = async () => { throw failure; }, diagnostic = vi.fn();
  const manager = await createHostProviderDiscovery({ stateDir: await root(), env: {}, create: async id => registration(id), prepare, onDiagnostic: diagnostic });
  expect(manager.enabled('opencode')).toBe(false);
  expect(manager.registrations.some(item => item.directory.providerId === 'opencode')).toBe(false);
  const previous = manager.snapshot().revision;
  failure = new OpenCodeServerError('opencode_auth_required', 'OpenCode rejected authentication. Configure matching server credentials in the Controller.');
  await manager.refresh();
  expect(manager.snapshot().revision).not.toBe(previous);
  expect(diagnostic.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({ providerId: 'opencode', outcome: 'unavailable', code: 'opencode_auth_required' }));
  failure = new Error('secret native token /private/profile');
  await manager.refresh();
  expect(JSON.stringify(manager.snapshot())).not.toMatch(/secret native token|private\/profile/);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret native token|private\/profile/);
  expect(manager.snapshot().providers.find(item => item.providerId === 'opencode')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('No supported installation') });
  await manager.stop();
});
