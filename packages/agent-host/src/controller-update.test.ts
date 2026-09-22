import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createControllerUpdater, installControllerRelease } from './controller-update.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'controller-update-')); roots.push(root); return root; }
const identity = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'b'.repeat(40), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', sha256: 'c'.repeat(64), nodeMajor: 22, platforms: ['darwin-arm64'] };
it('stages once, waits for safe restart and preserves operation identity across retries', async () => {
  const stateDir = await directory(); let safe = false; let installations = 0; const restarted: string[] = [];
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release,
    install: async () => { installations++; }, beginRestart: () => safe, restart: version => { restarted.push(version); } });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => updater.status()).toMatchObject({ phase: 'waiting' });
    await updater.request('0.2.0', 'operation-one');
    await expect(updater.request('0.2.0', 'operation-two')).rejects.toThrow('already pending');
    expect(installations).toBe(1); expect(restarted).toEqual([]);
    safe = true;
    await expect.poll(() => restarted, { timeout: 4000 }).toEqual(['0.2.0']);
    expect(JSON.parse(await readFile(join(stateDir, 'controller-updates/status.json'), 'utf8'))).toMatchObject({ phase: 'restarting', operationId: 'operation-one' });
  } finally { await updater.close(); }
});
it('reports a failed download without stopping the running Controller and allows explicit retry', async () => {
  const stateDir = await directory(); let attempts = 0; const restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release,
    install: async () => { attempts++; throw new Error('Network unavailable'); }, beginRestart: () => true, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(async () => (await updater.status()).phase).toBe('failed');
    expect(restart).not.toHaveBeenCalled();
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => attempts).toBe(2);
    await expect(updater.request('0.1.0', 'operation-old')).rejects.toThrow();
  } finally { await updater.close(); }
});
it('rejects tampered packages before npm or any current installation is changed', async () => {
  const root = await directory(); await mkdir(join(root, 'controller-updates')); await writeFile(join(root, 'controller-updates/current.json'), '{"version":"0.1.0"}');
  await expect(installControllerRelease(root, release, (async () => new Response('not-the-package')) as typeof fetch)).rejects.toThrow('checksum');
  expect(await readFile(join(root, 'controller-updates/current.json'), 'utf8')).toBe('{"version":"0.1.0"}');
});
it('reopens admission when launcher activation fails', async () => {
  const stateDir = await directory(); let draining = false;
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release, install: async () => {},
    beginRestart: () => { draining = true; return true; }, cancelRestart: () => { draining = false; },
    restart: async () => { throw new Error('Launcher disconnected'); } });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(async () => (await updater.status()).phase).toBe('failed');
    expect(draining).toBe(false);
  } finally { await updater.close(); }
});
it('keeps the Controller running when a failed update cannot persist its status', async () => {
  const stateDir = await directory(); const restart = vi.fn();
  const updater = createControllerUpdater({ stateDir, identity, release: async () => release,
    install: async () => {
      const path = join(stateDir, 'controller-updates/status.json');
      await rm(path); await mkdir(path);
      throw new Error('Installation failed');
    }, beginRestart: () => true, restart });
  try {
    await updater.request('0.2.0', 'operation-one');
    await expect.poll(() => updater.status(), { timeout: 3000 }).toMatchObject({ phase: 'failed', message: expect.stringContaining('could not be saved') });
    expect(restart).not.toHaveBeenCalled();
  } finally { await updater.close(); }
});
it('accepts a later version after the launcher settles a candidate observed while restarting', async () => {
  const stateDir = await directory(); const path = join(stateDir, 'controller-updates/status.json');
  await mkdir(join(stateDir, 'controller-updates'));
  const prior = { phase: 'restarting', version: '0.2.0', operationId: 'previous-update', updatedAt: Date.now() };
  await writeFile(path, JSON.stringify(prior));
  const updater = createControllerUpdater({ stateDir, identity: { ...identity, version: '0.2.0' },
    release: async () => ({ ...release, version: '0.3.0' }), install: async () => {}, beginRestart: () => false, restart: () => {} });
  try {
    expect((await updater.status()).phase).toBe('restarting');
    await writeFile(path, JSON.stringify({ ...prior, phase: 'succeeded' }));
    expect((await updater.status()).phase).toBe('succeeded');
    expect((await updater.request('0.3.0', 'next-update')).version).toBe('0.3.0');
    await expect.poll(async () => (await updater.status()).phase).toBe('waiting');
  } finally { await updater.close(); }
});
