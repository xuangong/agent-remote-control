import { describe, expect, it, vi } from 'vitest';

import { HttpPreviewClient } from './preview-client.js';

describe('HttpPreviewClient', () => {
  it('registers an explicit source against the namespaced session endpoint', async () => {
    const fetcher = vi.fn(async () => Response.json({ registration: registration() }));
    const client = new HttpPreviewClient('https://control.test/u/account/', fetcher as typeof fetch);

    const result = await client.register('agent/one', {
      target: 'http://127.0.0.1:5173/docs?tab=one', itemId: 'epoch:1', pathMode: 'preserve',
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://control.test/u/account/v1/sessions/agent%2Fone/previews',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ target: 'http://127.0.0.1:5173/docs?tab=one', itemId: 'epoch:1', pathMode: 'preserve' }) }),
    );
    expect(result.id).toBe('preview-one');
  });

  it('reports an actionable server error instead of accepting an unavailable API', async () => {
    const client = new HttpPreviewClient('/u/account/', vi.fn(async () => Response.json({ error: 'Preview tunnel is disabled.' }, { status: 503 })) as typeof fetch);
    await expect(client.snapshot('host-one')).rejects.toThrow('Preview tunnel is disabled.');
  });
});

function registration() {
  return {
    id: 'preview-one', target: 'http://127.0.0.1:5173', status: 'active' as const,
    createdAt: '2026-09-16T00:00:00.000Z', expiresAt: '2026-09-16T01:00:00.000Z', revision: 2,
    pathMode: 'preserve' as const, sources: [{ sessionId: 'agent/one', itemId: 'epoch:1' }], availability: 'online' as const,
  };
}
