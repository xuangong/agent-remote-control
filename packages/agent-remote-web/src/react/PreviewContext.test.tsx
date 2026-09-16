import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import type { HttpPreviewClient, PreviewRegistration, PreviewSnapshot } from '../client/preview-client.js';
import { PreviewProvider, usePreviewController } from './PreviewContext.js';

it('loads authoritative Host previews and synchronizes registration mutations', async () => {
  const snapshots: PreviewSnapshot[] = [{ epoch: 'host-one', revision: 1, registrations: [] }];
  const registration = activeRegistration();
  const client = {
    snapshot: vi.fn(async () => snapshots.at(-1)!),
    register: vi.fn(async () => { snapshots.push({ epoch: 'host-one', revision: 2, registrations: [registration] }); return registration; }),
    unregister: vi.fn(async () => ({ ...registration, status: 'unregistered' as const })),
    open: vi.fn(async () => 'https://preview.test/entry'),
  } as unknown as HttpPreviewClient;
  const container = await render(<PreviewProvider client={client} hostId="host-one" canManage><Probe /></PreviewProvider>);
  await act(async () => Promise.resolve());
  expect(container.textContent).toContain('0 previews');

  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="register"]')?.click());
  expect(container.textContent).toContain('1 previews');
  expect(client.snapshot).toHaveBeenCalledTimes(2);
});

function Probe() {
  const controller = usePreviewController();
  if (!controller) return null;
  return <><span>{controller.registrations.length} previews</span><button data-action="register" onClick={() => void controller.register('agent', { target: 'http://localhost:5173', itemId: 'one' })}>Register</button></>;
}

function activeRegistration(): PreviewRegistration {
  return { id: 'preview-one', target: 'http://localhost:5173', status: 'active', createdAt: '2026-09-16T00:00:00Z',
    expiresAt: '2026-09-16T01:00:00Z', revision: 2, pathMode: 'strip', sources: [{ sessionId: 'agent', itemId: 'one' }], availability: 'online' };
}
