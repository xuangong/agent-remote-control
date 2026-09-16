import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render, rerender } from '../test/setup.js';
import type { PreviewRegistration } from '../client/preview-client.js';
import { PreviewActions, discoverLoopbackTargets, type PreviewController } from './PreviewActions.js';

describe('PreviewActions', () => {
  it('discovers distinct loopback HTTP targets without registering during render', async () => {
    expect(discoverLoopbackTargets('Open http://localhost:5173/a and `127.0.0.1:5173/b`, not https://example.com.')).toEqual([
      'http://localhost:5173/a', 'http://127.0.0.1:5173/b',
    ]);
    const register = vi.fn(async () => activeRegistration());
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="http://localhost:5173/a" controller={controller({ register })} />);
    expect(register).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(register).toHaveBeenCalledWith('agent-one', { target: 'http://localhost:5173/a', itemId: 'epoch:1', pathMode: 'strip' });
  });

  it('reuses authoritative registration state and requires a click to request its entry URL', async () => {
    const open = vi.fn(async () => 'https://preview.test/auth/one');
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173/docs" controller={controller({ registrations: [activeRegistration()], open })} />);
    expect(container.textContent).toContain('Registered');
    expect(open).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>('.agent-preview-open')?.click());
    expect(open).toHaveBeenCalledWith('preview-one', 'http://localhost:5173/docs');
    expect(container.querySelector<HTMLAnchorElement>('.agent-preview-ready')?.href).toBe('https://preview.test/auth/one');
  });

  it('keeps offline availability separate from expiry and exposes path mode guidance', async () => {
    const offline = { ...activeRegistration(), availability: 'controller_offline' as const };
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173" controller={controller({ registrations: [offline] })} />);
    expect(container.textContent).toContain('Controller offline');
    expect(container.textContent).not.toContain('Expired');
    expect(container.textContent).toContain('configured with /p/preview-one/');
  });

  it('treats loopback aliases as one target and prefers an active registration', async () => {
    const expired = { ...activeRegistration(), id: 'preview-expired', status: 'expired' as const, revision: 8, pathMode: 'strip' as const };
    const active = { ...activeRegistration(), id: 'preview-active', target: 'http://127.0.0.1:5173', revision: 9 };
    const open = vi.fn(async () => 'https://preview.test/auth/active');
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173/docs"
      controller={controller({ registrations: [expired, active], open })} />);

    expect(container.textContent).toContain('Registered');
    expect(container.textContent).not.toContain('Register again');
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-preview-open')?.click());
    expect(open).toHaveBeenCalledWith('preview-active', 'http://localhost:5173/docs');
  });

  it('shows inactive lifecycle state explicitly', async () => {
    const expired = { ...activeRegistration(), status: 'expired' as const };
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173"
      controller={controller({ registrations: [expired] })} />);

    expect(container.querySelector('.agent-preview-state')?.textContent).toBe('Expired');
    expect(container.textContent).toContain('Register again');
  });

  it('removes a prepared entry link when its registration is no longer active', async () => {
    const open = vi.fn(async () => 'https://preview.test/auth/one');
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173"
      controller={controller({ registrations: [activeRegistration()], open })} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-preview-open')?.click());
    expect(container.querySelector('.agent-preview-ready')).not.toBeNull();

    const inactive = { ...activeRegistration(), status: 'unregistered' as const, revision: 3 };
    await rerender(container, <PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173"
      controller={controller({ registrations: [inactive], open })} />);
    expect(container.querySelector('.agent-preview-ready')).toBeNull();
  });

  it('disables entry preparation while unregister is pending', async () => {
    const registration = { ...activeRegistration(), pendingUnregister: true };
    const container = await render(<PreviewActions agentId="agent-one" itemId="epoch:1" text="localhost:5173"
      controller={controller({ registrations: [registration] })} />);

    expect(container.querySelector<HTMLButtonElement>('.agent-preview-open')?.disabled).toBe(true);
    expect(container.querySelector('.agent-preview-state')?.textContent).toBe('Unregister pending');
  });
});

function controller(overrides: Partial<PreviewController> = {}): PreviewController {
  return {
    registrations: [], canManage: true,
    register: async () => activeRegistration(), unregister: async () => undefined,
    open: async () => 'https://preview.test/entry', ...overrides,
  };
}

function activeRegistration(): PreviewRegistration {
  return {
    id: 'preview-one', target: 'http://localhost:5173', status: 'active', createdAt: 1_789_516_800_000,
    expiresAt: 1_789_520_400_000, revision: 2, pathMode: 'preserve', availability: 'online',
    sources: [{ sessionId: 'agent-one', itemId: 'epoch:1' }],
  };
}
