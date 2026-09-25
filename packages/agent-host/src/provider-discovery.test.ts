import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostProviderDiscovery } from './provider-discovery.js';
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
