import { mkdtemp, mkdir, lstat, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSystemdAutostart } from './platform/services/linux.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-systemd-')); roots.push(root);
  let available = true, active = false, enabled = false, failEnable = false;
  const commands: string[][] = [];
  const manager = createSystemdAutostart({ stateDir: join(root, 'private state'), home: root,
    configHome: join(root, 'config'), nodePath: '/opt/node % tools/node', cliPath: '/opt/$HOME/controller "app"/cli.js',
    cwd: '/work/project %n', path: '/opt/node/bin:/usr/bin',
    async run(args) {
      commands.push(args);
      const command = args[1];
      if (command === 'show-environment') return { code: available ? 0 : 1, stdout: '', stderr: '' };
      if (!available) return { code: 1, stdout: '', stderr: 'Failed to connect to bus' };
      if (command === 'is-active') return { code: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
      if (command === 'is-enabled') return { code: enabled ? 0 : 1, stdout: enabled ? 'enabled\n' : 'disabled\n', stderr: '' };
      if (command === 'enable') { if (failEnable) return { code: 1, stdout: '', stderr: 'Permission denied' }; enabled = true; }
      if (command === 'disable') enabled = false;
      if (command === 'start') active = true;
      if (command === 'stop') active = false;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  return { root, manager, commands, disconnect: () => { available = false; }, failEnable: () => { failEnable = true; } };
}

describe('Linux user service', () => {
  it('keeps startup enabled across stop and persists explicit disable', async () => {
    const { manager } = await setup();
    expect(await manager.available()).toBe(true);
    await manager.install(); await manager.start();
    expect(await manager.status()).toMatchObject({ enabled: true, installed: true, loaded: true, available: true, serviceEnabled: true });
    await manager.stop();
    expect(await manager.status()).toMatchObject({ enabled: true, installed: true, loaded: false, serviceEnabled: true });
    await manager.start(); await manager.disable();
    expect(await manager.status()).toMatchObject({ enabled: false, installed: false, loaded: false, serviceEnabled: false });
    await expect(manager.start()).rejects.toThrow(/disabled/);
    await manager.install(); await manager.start();
    expect(await manager.status()).toMatchObject({ enabled: true, loaded: true, serviceEnabled: true });
  });

  it('writes a private unit with literal paths and bounded owned-process cleanup', async () => {
    const { manager, root } = await setup();
    await manager.install();
    const { unitFile } = await manager.status();
    expect(unitFile.startsWith(join(root, 'config/systemd/user/'))).toBe(true);
    const unit = await readFile(unitFile, 'utf8');
    expect(unit).toContain('ExecStart="/opt/node %% tools/node" "/opt/$$HOME/controller \\"app\\"/cli.js" "_serve"');
    expect(unit).toContain('WorkingDirectory=/work/project %%n');
    expect(unit).toContain('Environment="AGENT_HOST_SUPERVISOR=systemd"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('TimeoutStopSec=30');
    expect(unit).toContain('StandardOutput=append:');
    expect(unit).toContain('WantedBy=default.target');
    expect((await stat(unitFile)).mode & 0o777).toBe(0o600);
  });

  it('reports unavailable user managers without silently installing a service', async () => {
    const { manager, disconnect } = await setup(); disconnect();
    expect(await manager.available()).toBe(false);
    expect(await manager.status()).toMatchObject({ available: false, installed: false, loaded: false, serviceEnabled: false });
    await expect(manager.install()).rejects.toThrow(/systemd user manager is unavailable/);
  });

  it('removes future startup while the user bus is unavailable without claiming a managed process stopped', async () => {
    const { manager, disconnect } = await setup();
    await manager.install(); await manager.start();
    const { unitFile, label } = await manager.status();
    const link = join(unitFile, '..', 'default.target.wants', label);
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(unitFile, link);
    disconnect();
    await expect(manager.stop()).rejects.toThrow(/systemd user manager is unavailable/);
    await manager.disable();
    expect(await manager.status()).toMatchObject({ enabled: false, installed: false, available: false });
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not claim enabled preferences when systemctl enable fails', async () => {
    const { manager, root, failEnable } = await setup();
    await manager.disable(); failEnable();
    await expect(manager.install()).rejects.toThrow(/enable failed/);
    expect(JSON.parse(await readFile(join(root, 'private state/autostart.json'), 'utf8'))).toEqual({ enabled: false });
  });

  it('rejects control characters before writing a service definition', async () => {
    const { root } = await setup();
    const manager = createSystemdAutostart({ stateDir: join(root, 'state'), home: root,
      nodePath: '/usr/bin/node', cliPath: '/opt/cli.js', cwd: '/work\nExecStart=/unexpected', path: '/usr/bin',
      run: async () => ({ code: 0, stdout: '', stderr: '' }) });
    await expect(manager.install()).rejects.toThrow(/control character/);
  });
});
