import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLaunchdAutostart, prepareLaunchdConnection, resolveLaunchdConnection } from './launchd.js';
import { saveIssuedCredential, saveRegisteredConnection } from './connection-config.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(missingDomain = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-launchd-')); roots.push(root);
  let loaded = false;
  const manager = createLaunchdAutostart({ stateDir: join(root, 'state'), home: root, nodePath: '/opt/node & tools/node',
    cliPath: '/opt/controller/cli.js', cwd: '/work/project', path: '/opt/node/bin:/usr/bin', uid: 501,
    async run(args) {
      if (args[0] === 'print') return { code: missingDomain ? 112 : loaded ? 0 : 113, stdout: '', stderr: '' };
      if (args[0] === 'bootstrap') {
        const plist = await readFile(args[2]!, 'utf8');
        if (!plist.includes('<key>ProgramArguments</key>') || !plist.includes('<string>_serve</string>'))
          return { code: 1, stdout: '', stderr: 'Invalid service definition' };
        loaded = true;
      }
      if (args[0] === 'bootout') loaded = false;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  return { root, manager, stateDir: join(root, 'state') };
}

describe('Agent Host login startup', () => {
  it('removes future login startup even when the GUI domain is unavailable', async () => {
    const { manager } = await setup(true);
    await manager.install();
    expect(await manager.status()).toMatchObject({ enabled: true, installed: true, loaded: false });
    await manager.disable();
    expect(await manager.status()).toMatchObject({ enabled: false, installed: false, loaded: false });
  });
  it('keeps login startup enabled after stopping a loaded service and persists explicit disable', async () => {
    const { manager, stateDir } = await setup();
    expect((await manager.status()).enabled).toBe(true);
    await manager.install(); await manager.start();
    expect(await manager.status()).toMatchObject({ enabled: true, installed: true, loaded: true });
    await manager.stop(); await manager.stop();
    expect(await manager.status()).toMatchObject({ enabled: true, installed: true, loaded: false });
    await manager.start(); await manager.disable();
    expect(await manager.status()).toMatchObject({ enabled: false, installed: false, loaded: false });
    expect(JSON.parse(await readFile(join(stateDir, 'autostart.json'), 'utf8'))).toEqual({ enabled: false });
  });

  it('writes a private direct supervisor definition with restored paths and no pairing credential', async () => {
    const { manager, stateDir } = await setup();
    await prepareLaunchdConnection(stateDir, { serverUrl: 'https://relay.test', remoteKey: 'pairing-secret', environment: {
      HOME: '/private/home', PATH: '/private/bin', AGENT_HOST_WORKSPACE: '/work/project', COPILOT_AUTO_UPDATE: 'false', PRIVATE_SECRET: 'unrelated-secret',
    } });
    await manager.install();
    const { plist } = await manager.status();
    const contents = await readFile(plist, 'utf8');
    expect(contents).toContain('<string>/opt/node &amp; tools/node</string>');
    expect(contents).toContain('<key>KeepAlive</key><true/>');
    expect(contents).toContain('<key>WorkingDirectory</key><string>/work/project</string>');
    expect(contents).toContain('<key>PATH</key><string>/opt/node/bin:/usr/bin</string>');
    expect(contents).not.toContain('pairing-secret');
    expect(contents).not.toContain('unrelated-secret');
    expect((await stat(plist)).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateDir, 'launchd-start.json'))).mode & 0o777).toBe(0o600);
    const resolved = await resolveLaunchdConnection(stateDir, { HOME: '/runtime/home', PATH: '/runtime/bin' });
    expect(resolved.connection.remoteKey).toBe('pairing-secret');
    expect(resolved.connection.environment.AGENT_HOST_WORKSPACE).toBe('/work/project');
    expect(resolved.connection.environment.COPILOT_AUTO_UPDATE).toBe('false');
    expect(resolved.connection.environment.PRIVATE_SECRET).toBeUndefined();
  });

  it('never reapplies an initial pairing key after a credential rotation changes saved settings', async () => {
    const { stateDir } = await setup();
    const initial = { serverUrl: 'https://relay.test', remoteKey: 'initial', environment: { AGENT_HOST_WORKSPACE: '/work' } };
    await prepareLaunchdConnection(stateDir, initial);
    await saveIssuedCredential(stateDir, initial, 'rotated');
    const restarted = await resolveLaunchdConnection(stateDir, {});
    expect(restarted.connection.remoteKey).toBe('rotated');
    expect(restarted.pendingId).toBeUndefined();
    await prepareLaunchdConnection(stateDir, { ...initial, remoteKey: 'replacement' });
    expect((await resolveLaunchdConnection(stateDir, {})).connection.remoteKey).toBe('replacement');
    await saveRegisteredConnection(stateDir, { ...initial, remoteKey: 'paired-elsewhere' }, Promise.resolve());
    expect((await resolveLaunchdConnection(stateDir, {})).connection.remoteKey).toBe('paired-elsewhere');
  });
});
