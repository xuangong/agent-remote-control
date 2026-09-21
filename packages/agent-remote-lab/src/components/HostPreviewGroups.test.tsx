import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpPreviewClient } from '@orchardworks/agent-remote-web';
import { PreviewProvider } from '@orchardworks/agent-remote-web/react';
import { render } from '../test/setup.js';
import { HostPreviewGroups } from './HostPreviewGroups.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('groups identical local origins by Host and sends mutations and opens to the chosen Host', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  Object.defineProperties(HTMLDialogElement.prototype, {
    show: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  const removed = new Set<string>(); const pinned = new Set<string>();
  const registrations = (host: string) => removed.has(host) ? [] : [{ id: `preview-${host}`, target: 'http://127.0.0.1:5173', status: 'active' as const,
    availability: 'online' as const, pathMode: 'strip' as const, sources: [], revision: 1, createdAt: 1, expiresAt: Date.now() + 60000,
    tunnelOrigin: `https://${host}.example`, tunnelNamePinned: pinned.has(host) }];
  const client = {
    snapshot: vi.fn(async (host: string) => ({ epoch: host, revision: 1, routing: 'subdomain' as const, registrations: registrations(host) })),
    pinName: vi.fn(async (host: string) => { pinned.add(host); }),
    unregister: vi.fn(async (host: string) => { removed.add(host); }),
    open: vi.fn(async () => 'https://two.example/_arc/start'),
    enter: vi.fn(async () => 'https://two.example/'),
    renew: vi.fn(async () => registrations('two')[0]!),
  } as unknown as HttpPreviewClient;
  const hosts = [{ id: 'one', name: 'Work Mac', online: true }, { id: 'two', name: 'Home Mac', online: true }];
  const container = await render(<PreviewProvider client={client} hostId="one" canManage>
    <HostPreviewGroups client={client} hosts={hosts} activeHostId="one" polling onOpen={() => {}} onOpenSource={() => {}} />
  </PreviewProvider>);
  const groups = container.querySelectorAll('.lab-host-previews');
  expect(groups).toHaveLength(2);
  expect(groups[0]!.textContent).toContain('Work Mac'); expect(groups[1]!.textContent).toContain('Home Mac');
  await act(async () => groups[1]!.querySelector<HTMLButtonElement>('.lab-preview-pin')!.click());
  expect(client.pinName).toHaveBeenCalledWith('two', 'preview-two', true);
  expect(groups[0]!.querySelector('.lab-preview-pin')?.textContent).toBe('Pin tunnel name');
  expect(groups[1]!.querySelector('.lab-preview-pin')?.textContent).toBe('Unpin tunnel name');
  await act(async () => groups[1]!.querySelector<HTMLButtonElement>('.lab-preview-open')!.click());
  expect(client.open).toHaveBeenCalledWith('two', 'preview-two', 'http://127.0.0.1:5173', expect.any(AbortSignal));
  expect(client.renew).toHaveBeenCalledWith('two', 'preview-two', 'http://127.0.0.1:5173', expect.any(AbortSignal));
  await act(async () => groups[1]!.querySelector<HTMLButtonElement>('.lab-preview-unregister')!.click());
  expect(client.unregister).toHaveBeenCalledWith('two', 'preview-two');
  expect(groups[0]!.querySelectorAll('li')).toHaveLength(1); expect(groups[1]!.querySelectorAll('li')).toHaveLength(0);
});
