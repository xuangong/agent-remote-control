import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
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
    id: 'preview-one', target: 'http://localhost:5173', status: 'active', createdAt: '2026-09-16T00:00:00Z',
    expiresAt: '2026-09-16T01:00:00Z', revision: 2, pathMode: 'preserve', availability: 'online',
    sources: [{ sessionId: 'agent-one', itemId: 'epoch:1' }],
  };
}
