import { describe, expect, it } from 'vitest';
import { detectHostEnvironment, type EnvironmentProbe } from './environment.js';

function probe(overrides: Partial<EnvironmentProbe> = {}): EnvironmentProbe {
  return { platform: 'linux', arch: 'x64', release: '6.8.0', home: '/home/test', env: { PATH: '/usr/bin' },
    userShell: () => '/bin/bash', now: () => 1234,
    read: async () => undefined, available: async () => 'not-found', ...overrides };
}

describe('Host environment detection', () => {
  it('reports the execution OS, WSL and container separately and uses the account shell', async () => {
    const result = await detectHostEnvironment(probe({ release: '6.6.87-microsoft-standard-WSL2', env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      read: async path => path === '/etc/os-release' ? 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n' : undefined,
      available: async path => path === '/.dockerenv' || path === '/usr/bin/chromium' ? 'found' : 'not-found' }));
    expect(result).toMatchObject({ detectedAt: 1234, os: { platform: 'linux', name: 'Ubuntu 24.04 LTS', arch: 'x64' },
      wsl: true, container: true, shell: { name: 'bash', source: 'account' } });
    expect(result.browsers.find(item => item.id === 'chromium')?.status).toBe('found');
    expect(result.browsers.find(item => item.id === 'chrome')?.status).toBe('not-found');
  });
  it('finds macOS applications without relying on GUI application launch or PATH', async () => {
    const result = await detectHostEnvironment(probe({ platform: 'darwin', userShell: () => '/bin/zsh',
      available: async path => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'].includes(path) ? 'found' : 'not-found' }));
    expect(result.os.name).toBe('macOS');
    expect(result.shell).toEqual({ name: 'zsh', source: 'account' });
    expect(result.browsers.find(item => item.id === 'chrome')?.status).toBe('found');
    expect(result.vscode.status).toBe('found');
  });
  it('keeps inaccessible probes unknown and does not report credentials or local paths', async () => {
    const result = await detectHostEnvironment(probe({ userShell: () => { throw Error('denied'); },
      env: { PATH: '/secret/bin', OPENAI_API_KEY: 'secret-value' }, available: async () => 'unknown', read: async () => { throw Error('denied'); } }));
    expect(result.shell).toEqual({ source: 'unknown' });
    expect(result.browsers.every(item => item.status === 'unknown')).toBe(true);
    expect(result.container).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/secret|denied/);
  });
  it('does not infer a Windows primary shell from the presence of PowerShell', async () => {
    const result = await detectHostEnvironment(probe({ platform: 'win32', home: 'C:\\Users\\test', userShell: () => undefined,
      env: { PATH: 'C:\\Tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: 'C:\\Windows' },
      available: async path => path === 'C:\\Tools\\pwsh.exe' ? 'found' : 'not-found' }));
    expect(result.shell).toEqual({ name: 'cmd', source: 'environment' });
    expect(result.shells.find(item => item.id === 'pwsh')?.status).toBe('found');
    expect(result.os.name).toBe('Windows');
  });
});

it('honors configured executable names and finds standard tools outside the service PATH', async () => {
  const result = await detectHostEnvironment(probe({ env: { PATH: '/custom', AGENT_HOST_VSCODE: 'my-code' },
    available: async path => ['/custom/my-code', '/bin/zsh'].includes(path) ? 'found' : 'not-found' }));
  expect(result.vscode.status).toBe('found');
  expect(result.shells.find(item => item.id === 'zsh')?.status).toBe('found');
});

it('finishes detection when an environment probe stalls', async () => {
  const result = await detectHostEnvironment(probe({ read: () => new Promise(() => {}), available: () => new Promise(() => {}) }));
  expect(result.browsers.every(item => item.status === 'unknown')).toBe(true);
  expect(result.container).toBeNull();
}, 3000);
