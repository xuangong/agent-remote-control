import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { PreviewContextValue } from '@agent-remote-controller/agent-remote-web/react';

import { render } from '../test/setup.js';
import { HostPreviewList } from './HostPreviewList.js';

it('shows lifecycle, availability, source navigation, and owner-only unregister controls', async () => {
  const unregister = vi.fn(async () => undefined);
  const openSource = vi.fn();
  const controller = value({ unregister });
  const container = await render(<HostPreviewList controller={controller} onOpenSource={openSource} />);
  expect(container.textContent).toContain('Active');
  expect(container.textContent).toContain('Controller offline');
  expect(container.textContent).not.toContain('Expired');

  await act(async () => container.querySelector<HTMLButtonElement>('.lab-preview-source')?.click());
  expect(openSource).toHaveBeenCalledWith('agent-one', 'epoch:1');
  await act(async () => container.querySelector<HTMLButtonElement>('.lab-preview-unregister')?.click());
  expect(unregister).toHaveBeenCalledWith('preview-one');
});

it('keeps shared Host previews visible and requires a click before exposing an entry link', async () => {
  const open = vi.fn(async () => 'https://preview.test/entry/one');
  const shared = value({ canManage: false, open });
  const container = await render(<HostPreviewList controller={{ ...shared, registrations: shared.registrations.map(item => ({ ...item, availability: 'online' })) }} />);
  expect(container.textContent).toContain('localhost:5173');
  expect(container.querySelector('.lab-preview-unregister')).toBeNull();
  expect(container.textContent).toContain('Only the Host owner can unregister previews.');
  expect(open).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('.lab-preview-open')?.click());
  expect(open).toHaveBeenCalledWith('preview-one', 'http://localhost:5173');
  expect(container.querySelector<HTMLAnchorElement>('.lab-preview-ready')?.href).toBe('https://preview.test/entry/one');
});

function value(overrides: Partial<PreviewContextValue> = {}): PreviewContextValue {
  return {
    registrations: [{ id: 'preview-one', target: 'http://localhost:5173', status: 'active', createdAt: '2026-09-16T00:00:00Z',
      expiresAt: '2026-09-16T01:00:00Z', revision: 1, pathMode: 'strip', availability: 'controller_offline',
      sources: [{ sessionId: 'agent-one', itemId: 'epoch:1' }] }],
    canManage: true, loading: false, register: async () => { throw new Error('unused'); }, unregister: async () => undefined,
    open: async () => '', refresh: async () => undefined, ...overrides,
  };
}
