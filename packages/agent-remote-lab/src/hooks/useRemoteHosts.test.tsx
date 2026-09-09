import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';

it('restores mobile conversation actions when its Host reconnects while Context is unmounted', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const baseUrl = 'http://127.0.0.1:6175';
  const agentId = replicaState.agent!.id;
  window.localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ agentId, nativeSessionId: 'native', providerId: 'dsh', title: 'Mobile conversation', hostId: 'host-1' }]));
  let online = false;
  const hosts = vi.fn(async () => ({ hosts: [{ id: 'local', name: 'Local runtime', online: true }, { id: 'host-1', name: 'My DSH', online }] }));
  const directory = new SessionDirectoryClient(baseUrl);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  try {
    const container = await render(<App baseUrl={baseUrl} directory={directory} hostService={{ hosts, pair: vi.fn() }} initialState={replicaState} initialSessionStatus="ready" actions={{ sendMessage }} />);
    expect(container.querySelector('#lab-context')).toBeNull();
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
    expect(input.disabled).toBe(true);
    online = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hosts).toHaveBeenCalledTimes(2);
    expect(container.querySelector('#lab-context')).toBeNull();
    expect(input.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'After the Host reconnects');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
    expect(sendMessage).toHaveBeenCalledWith('After the Host reconnects');
  } finally {
    window.localStorage.removeItem(`agent-remote-opened:${baseUrl}`);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
