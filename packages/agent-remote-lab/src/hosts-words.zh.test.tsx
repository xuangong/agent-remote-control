import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { translator, errorWords } from '@orchardworks/agent-client';
import { render } from './test/setup.js';
import { ControllerUpdates } from './components/ControllerUpdates.js';
import { HostEnvironmentDetails, HostPairing } from './components/HostPairing.js';
import { type HostPairingService, type RemoteHost } from './kernel/remote-host.js';
import { HostSecurityActions } from './components/HostSecurityActions.js';
import { PairingKeys } from './components/PairingKeys.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { browserSessions } from './security-client.js';
import { RemoteHostClient } from './directory-client.js';

const zh = (node: React.ReactNode) => render(<LocaleContext.Provider value="zh">{node}</LocaleContext.Provider>);
afterEach(() => vi.unstubAllGlobals());

const environment = { detectedAt: 1234, os: { platform: 'linux', name: 'Ubuntu', release: '6.8', arch: 'arm64' },
  wsl: false, container: true, shell: { name: 'bash', source: 'account' as const }, shells: [],
  browsers: [{ id: 'chromium', name: 'Chromium', status: 'found' as const }], vscode: { status: 'not-found' as const } };
const host: RemoteHost = { id: 'studio', name: 'Studio', online: true, managed: true, environment, credentialRotation: true,
  controller: { version: '0.1.0', platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true } as RemoteHost['controller'] };
const service: HostPairingService = { hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); } };

describe('the Computers, pairing and security screens in Chinese', () => {
  it('says the pairing keys in the reader\'s words', async () => {
    const view = await zh(<PairingKeys service={{ ...service, pairings: async () => ({ pairings: [], availablePurposes: ['host-only'] }) }} />);
    expect(view.textContent).toContain('配对密钥历史');
    expect(view.textContent).toContain('还没有配对密钥。');
    expect([...view.querySelectorAll('button')].some(button => button.textContent === '生成配对密钥')).toBe(true);
  });

  it('says a Host\'s environment and picker in the reader\'s words', async () => {
    const view = await zh(<><HostPairing selectedHostId="studio" hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />
      <HostEnvironmentDetails host={{ ...host, access: 'shared' }} /></>);
    expect(view.textContent).toContain('已连接的 Host');
    expect(view.textContent).toContain('检测详情');
    expect(view.textContent).toContain('容器');
    expect(view.querySelector<HTMLSelectElement>('#remote-host')?.selectedOptions[0]?.textContent).toContain('在线');
  });

  it('asks before replacing a Host credential in the reader\'s words', async () => {
    const view = await zh(<HostSecurityActions host={host} service={{ ...service, rotate: async () => ({ ok: true, status: 'pending' }) }} />);
    await act(async () => [...view.querySelectorAll('button')].find(button => button.textContent === '更换凭据')!.click());
    expect(view.textContent).toContain('更换 Studio 保存的凭据？');
  });

  it('says the Controller updates in the reader\'s words', async () => {
    const release = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'x.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
    const view = await zh(<ControllerUpdates service={{ ...service, controllerRelease: async () => ({ release }) }} hosts={[host]} />);
    await act(async () => view.querySelector('button')!.click());
    expect(view.textContent).toContain('最新版本：');
    expect([...view.querySelectorAll('button')].some(button => button.textContent === '更新 Host')).toBe(true);
  });

  it('says the security panel in the reader\'s words', async () => {
    const now = Date.now();
    vi.stubGlobal('fetch', async (url: string) => url === '/auth/sessions'
      ? Response.json({ sessions: [{ id: 'browser:abcdef123', label: 'Laptop', createdAt: now, lastSeenAt: now, expiresAt: now + 1000, current: true, identified: true }], authenticatedAt: now, recentAuthentication: true })
      : Response.json({ events: [] }));
    const view = await zh(<SecurityPanel onClose={() => undefined} onSignedOut={() => undefined} />);
    expect(view.querySelector('h1')?.textContent).toBe('安全');
    expect(view.textContent).toContain('已登录的浏览器');
    expect(view.textContent).toContain('当前浏览器');
    expect(view.textContent).toContain('最近没有安全动态。');
  });

  it('shows the errors the client makes in the reader\'s language and leaves what the Relay sent as sent', async () => {
    const t = translator('zh');
    vi.stubGlobal('fetch', async () => Response.json({}, { status: 401 }));
    const expired = await browserSessions().catch(error => error);
    expect(expired.message).toBe('Your browser session has expired.');
    expect(errorWords(expired, t)).toBe('这个浏览器的登录已过期。');
    vi.stubGlobal('fetch', async () => Response.json({}, { status: 500 }));
    const unavailable = await new RemoteHostClient('https://relay.example').hosts().catch(error => error);
    expect(errorWords(unavailable, t)).toBe('远程 Host 服务暂时用不了。');
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Quota exceeded' }, { status: 429 }));
    const sent = await new RemoteHostClient('https://relay.example').hosts().catch(error => error);
    expect(errorWords(sent, t)).toBe('Quota exceeded');
  });
});
