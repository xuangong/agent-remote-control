import { describe, expect, it, vi } from 'vitest';

import { HttpPreviewClient } from './preview-client.js';

describe('HttpPreviewClient', () => {
  it('binds isolated entry to the origin returned by the authenticated open request', async () => {
    const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
    const client = new HttpPreviewClient('https://control.test/u/account/', (async (input, init) => {
      const url = String(input); requests.push({ url, credentials: init?.credentials });
      if (url.endsWith('/open')) return Response.json({ entryUrl: 'https://t-one.preview.test/_arc/start?path=%2Fdocs' });
      if (url.endsWith('/_arc/challenge')) return Response.json({ challenge: 'browser-challenge' });
      if (url.endsWith('/_arc/preview-authorize')) return Response.json({ code: 'bound-proof' });
      if (url.endsWith('/_arc/enter')) return Response.json({ url: '/docs' });
      throw new Error('Unexpected request');
    }) as typeof fetch);
    const entry = await client.open('host', 'one', 'http://localhost:5173/docs');
    expect(await client.enter(entry, 'one')).toBe('https://t-one.preview.test/docs');
    expect(requests.slice(1)).toEqual([
      { url: 'https://t-one.preview.test/_arc/challenge', credentials: 'include' },
      { url: 'https://control.test/_arc/preview-authorize', credentials: 'same-origin' },
      { url: 'https://t-one.preview.test/_arc/enter', credentials: 'include' },
    ]);
    await expect(client.enter('https://other.test/_arc/start', 'one')).rejects.toThrow('authorized tunnel origin');
  });
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

  it('preserves a terminal renewal rejection status for retained previews', async () => {
    const client = new HttpPreviewClient('https://control.test/', vi.fn(async () => Response.json({ error: 'Unregistered' }, { status: 409 })) as typeof fetch);
    await expect(client.renew('host', 'preview', 'http://localhost:5173')).rejects.toMatchObject({ status: 409, message: 'Unregistered' });
  });
});

function registration() {
  return {
    id: 'preview-one', target: 'http://127.0.0.1:5173', status: 'active' as const,
    createdAt: 1_789_516_800_000, expiresAt: 1_789_520_400_000, revision: 2,
    pathMode: 'preserve' as const, sources: [{ sessionId: 'agent/one', itemId: 'epoch:1' }], availability: 'online' as const,
  };
}

it('redeems the handoff with a path-scoped cookie without exposing the proof in the destination', async () => {
  const fetcher = vi.fn(async () => Response.json({ url: '/p/one/docs?view=mobile#section' }));
  const client = new HttpPreviewClient('https://control.test/u/account/', fetcher as typeof fetch);
  expect(await client.enter('https://control.test/_arc/enter#one-use-proof', 'one')).toBe('https://control.test/p/one/docs?view=mobile#section');
  expect(fetcher).toHaveBeenCalledWith('https://control.test/_arc/enter', expect.objectContaining({
    credentials: 'same-origin', method: 'POST', body: '{"code":"one-use-proof"}',
  }));
});

it('rejects a handoff or destination outside the selected preview', async () => {
  const fetcher = vi.fn(async () => Response.json({ url: '/p/another/' }));
  const client = new HttpPreviewClient('https://control.test/u/account/', fetcher as typeof fetch);
  await expect(client.enter('https://other.test/_arc/enter#proof', 'one')).rejects.toThrow('same Relay origin');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(client.enter('https://control.test/_arc/enter#proof', 'one')).rejects.toThrow('destination is invalid');
});

it('reports expired preview access before embedding an unauthenticated page', async () => {
  const client = new HttpPreviewClient('https://control.test/', (async () => Response.json({ error: 'Unavailable' }, { status: 401 })) as typeof fetch);
  await expect(client.enter('https://control.test/_arc/enter#proof', 'one')).rejects.toThrow('expired or is unavailable');
});


it('recovers an expired preview cookie with a fresh handoff while keeping the registered ID', async () => {
  const paths: string[] = [];
  const client = new HttpPreviewClient('https://control.test/u/account/', (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith('/previews/preview-one/renew')) return Response.json({ registration: registration() });
    if (path === '/p/preview-one/_arc/renew') return Response.json({}, { status: 401 });
    if (path.endsWith('/open')) return Response.json({ entryUrl: 'https://control.test/_arc/enter#fresh-proof' });
    if (path === '/_arc/enter') return Response.json({ url: '/p/preview-one/docs' });
    throw new Error('Unexpected request');
  }) as typeof fetch);
  expect((await client.renew('host-one', 'preview-one', 'http://localhost:5173/docs')).id).toBe('preview-one');
  expect(paths).toEqual(['/u/account/v1/remote/hosts/host-one/previews/preview-one/renew', '/p/preview-one/_arc/renew',
    '/u/account/v1/remote/hosts/host-one/previews/preview-one/open', '/_arc/enter']);
});


it('requests a credential-free navigation link without redeeming an iframe handoff', async () => {
  const tunnelUrl = 'https://control.test/?host=host&preview=preview&path=%2Fdocs';
  const fetcher = vi.fn(async () => Response.json({ tunnelUrl }));
  const client = new HttpPreviewClient('https://control.test/u/account/', fetcher as typeof fetch);
  expect(await client.tunnelUrl('host', 'preview', 'http://localhost:5173/docs')).toBe(tunnelUrl);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith('https://control.test/u/account/v1/remote/hosts/host/previews/preview/open', expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: 'http://localhost:5173/docs', mode: 'link' }) }));
});
