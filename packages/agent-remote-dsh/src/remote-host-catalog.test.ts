import { describe, expect, it, vi } from 'vitest';
import { RemoteHostCatalog, RemoteHostCatalogError, type RemoteSessionSummary } from './remote-host-catalog.js';

function summary(nativeSessionId: string, overrides: Partial<RemoteSessionSummary> = {}): RemoteSessionSummary {
  return {
    nativeSessionId, providerId: 'dsh', title: nativeSessionId,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', state: 'idle',
    ...overrides,
  };
}

async function expectCatalogError(action: () => unknown, code: RemoteHostCatalogError['code'], status: number) {
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(RemoteHostCatalogError);
  expect(caught).toMatchObject({ code, status });
}

describe('RemoteHostCatalog', () => {
  it('reads current metadata for a session outside the first page without replacing a retained view', async () => {
    const roots = Array.from({ length: 35 }, (_, index) => summary(`session-${String(index).padStart(2, '0')}`));
    const catalog = new RemoteHostCatalog({ roots: () => roots, maxViews: 1 });
    const first = await catalog.page();
    expect(first.items).toHaveLength(30);
    expect(first.items.some((item) => item.nativeSessionId === 'session-34')).toBe(false);
    expect(await catalog.session('session-34')).toEqual(summary('session-34'));
    roots[34].title = 'Current working directory';
    const current = await catalog.session('session-34');
    expect(current).toEqual(summary('session-34', { title: 'Current working directory' }));
    current!.title = 'Caller edit';
    expect((await catalog.session('session-34'))?.title).toBe('Current working directory');
    const continuation = await catalog.page({ cursor: first.nextCursor });
    expect(continuation.items.map((item) => item.nativeSessionId)).toEqual(['session-30', 'session-31', 'session-32', 'session-33', 'session-34']);
    expect(continuation.items[4].title).toBe('session-34');
    expect(continuation.revision).toBe(first.revision);
  });

  it('returns no metadata for absent or removed native identities and stops reads after disposal', async () => {
    let roots = [summary('session')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    expect(await catalog.session('missing')).toBeUndefined();
    expect((await catalog.session('session'))?.nativeSessionId).toBe('session');
    roots = [];
    expect(await catalog.session('session')).toBeUndefined();
    catalog.dispose();
    await expectCatalogError(() => catalog.session('session'), 'cursor_expired', 409);
  });

  it('coalesces concurrent asynchronous reads and keeps frozen pages through a cold-to-live change', async () => {
    let release!: (items: RemoteSessionSummary[]) => void;
    const roots = vi.fn(() => new Promise<RemoteSessionSummary[]>((resolve) => { release = resolve; }));
    const catalog = new RemoteHostCatalog({ roots });
    const firstRead = catalog.page({ limit: 1 });
    const revisionRead = catalog.revision();
    expect(roots).toHaveBeenCalledTimes(1);
    release([summary('a'), summary('b')]);
    const first = await firstRead;
    expect(await revisionRead).toBe(first.revision);
    roots.mockResolvedValue([summary('b', { title: 'Restored title', state: 'running' }), summary('a')]);
    const second = await catalog.page({ cursor: first.nextCursor });
    expect(second.items).toEqual([summary('b')]);
    expect(second.revision).toBe(first.revision);
    expect((await catalog.page()).items[1]).toEqual(summary('b', { title: 'Restored title', state: 'running' }));
  });

  it('preserves retained views and recovers after an asynchronous native listing failure', async () => {
    const roots = vi.fn(async () => [summary('a'), summary('b')]);
    const catalog = new RemoteHostCatalog({ roots });
    const first = await catalog.page({ limit: 1 });
    roots.mockRejectedValueOnce(new Error('Native index unavailable'));
    await expect(catalog.page()).rejects.toThrow('Native index unavailable');
    expect((await catalog.page({ cursor: first.nextCursor })).items).toEqual([summary('b')]);
    expect(await catalog.revision()).toBe(first.revision);
  });

  it('does not publish an asynchronous read after disposal', async () => {
    let release!: (items: RemoteSessionSummary[]) => void;
    const catalog = new RemoteHostCatalog({ roots: () => new Promise((resolve) => { release = resolve; }) });
    const reading = catalog.page();
    catalog.dispose();
    release([summary('a')]);
    await expect(reading).rejects.toMatchObject({ code: 'cursor_expired' });
  });

  it('traverses 1,000 equal-time sessions exactly once in deterministic identity order', async () => {
    const roots = Array.from({ length: 1000 }, (_, index) => summary(`session-${String(index).padStart(4, '0')}`));
    const catalog = new RemoteHostCatalog({ roots: () => [...roots].reverse() });
    let page = (await catalog.page());
    const revision = page.revision;
    expect(page.items).toHaveLength(30);
    expect(page.items[0].nativeSessionId).toBe('session-0000');
    const ids = page.items.map((item) => item.nativeSessionId);
    let requests = 1;
    while (page.hasMore && requests < 40) {
      page = (await catalog.page({ cursor: page.nextCursor }));
      expect(page.revision).toBe(revision);
      ids.push(...page.items.map((item) => item.nativeSessionId));
      requests++;
    }
    expect(requests).toBe(34);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items).toHaveLength(10);
    expect(ids).toEqual(roots.map((item) => item.nativeSessionId));
    expect(new Set(ids).size).toBe(1000);
  });

  it('sorts valid update times newest first and falls back to creation time', async () => {
    const roots = [
      summary('invalid-z', { updatedAt: '', createdAt: '' }),
      summary('updated-old', { updatedAt: '2026-01-01', createdAt: '2026-12-01' }),
      summary('fallback', { updatedAt: 'invalid', createdAt: '2026-09-08' }),
      summary('updated-b'), summary('updated-a'),
      summary('invalid-a', { updatedAt: 'invalid', createdAt: 'invalid' }),
    ];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    expect((await catalog.page()).items.map((item) => item.nativeSessionId)).toEqual([
      'fallback', 'updated-a', 'updated-b', 'updated-old', 'invalid-a', 'invalid-z',
    ]);
  });

  it('changes revision only when metadata or membership changes', async () => {
    let roots = [summary('a'), summary('b')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    const original = (await catalog.revision());
    roots = [...roots].reverse().map((item) => ({ ...item }));
    expect((await catalog.revision())).toBe(original);
    expect((await catalog.page()).revision).toBe(original);
    roots[0].title = 'Renamed';
    const renamed = (await catalog.revision());
    expect(renamed).not.toBe(original);
    expect((await catalog.revision())).toBe(renamed);
    roots.push(summary('c'));
    const added = (await catalog.revision());
    expect(added).not.toBe(renamed);
    roots = roots.filter((item) => item.nativeSessionId !== 'a');
    expect((await catalog.revision())).not.toBe(added);
  });

  it('freezes summaries and membership while marking removed entries unavailable', async () => {
    let roots = [summary('a'), summary('b'), summary('c')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    const first = (await catalog.page({ limit: 1 }));
    roots = [summary('b', { title: 'Changed', updatedAt: '2026-09-09', state: 'running' }), summary('new', { updatedAt: '2026-09-10' })];
    const second = (await catalog.page({ cursor: first.nextCursor }));
    expect(second.items).toEqual([summary('b')]);
    const third = (await catalog.page({ cursor: second.nextCursor }));
    expect(third.items).toEqual([summary('c', { state: 'unavailable' })]);
    expect(third.revision).toBe(first.revision);
    expect((await catalog.page({ cursor: second.nextCursor }))).toEqual(third);
    const fresh = (await catalog.page());
    expect(fresh.items.map((item) => item.nativeSessionId)).toEqual(['new', 'b']);
    expect(fresh.revision).not.toBe(first.revision);
  });

  it('isolates retained metadata from caller mutations', async () => {
    const roots = [summary('a'), summary('b')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    const first = (await catalog.page({ limit: 1 }));
    roots[1].title = 'Native mutation';
    const second = (await catalog.page({ cursor: first.nextCursor }));
    expect(second.items[0].title).toBe('b');
    second.items[0].title = 'Response mutation';
    expect((await catalog.page({ cursor: first.nextCursor })).items[0].title).toBe('b');
    expect((await catalog.page()).items[1].title).toBe('Native mutation');
  });

  it('keeps a removed identity unavailable in its view after that identity is added again', async () => {
    let roots = [summary('a'), summary('b')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    const first = (await catalog.page({ limit: 1 }));
    roots = [summary('a')];
    (await catalog.revision());
    roots.push(summary('b', { title: 'Replacement' }));
    expect((await catalog.page({ cursor: first.nextCursor })).items).toEqual([summary('b', { state: 'unavailable' })]);
    expect((await catalog.page()).items[1].title).toBe('Replacement');
  });

  it('does not allocate, extend, or evict views during revision checks', async () => {
    let now = 0;
    const roots = [summary('a'), summary('b'), summary('c')];
    const catalog = new RemoteHostCatalog({ roots: () => roots, now: () => now, maxViews: 1 });
    const first = (await catalog.page({ limit: 1 }));
    now = 119_999;
    for (let index = 0; index < 20; index++) {
      roots[2].title = `Changed ${index}`;
      (await catalog.revision());
    }
    expect((await catalog.page({ cursor: first.nextCursor })).items[0].nativeSessionId).toBe('b');
    now = 120_000;
    (await catalog.revision());
    await expectCatalogError(async () => (await catalog.page({ cursor: first.nextCursor })), 'cursor_expired', 409);
    expect((await catalog.page()).items[2].title).toBe('Changed 19');
  });

  it('expires a view at its configured lifetime without refreshing it on continuation', async () => {
    let now = 20;
    const catalog = new RemoteHostCatalog({ roots: () => [summary('a'), summary('b'), summary('c')], now: () => now, viewTtlMs: 10 });
    const first = (await catalog.page({ limit: 1 }));
    now = 29;
    const second = (await catalog.page({ cursor: first.nextCursor }));
    expect(second.items[0].nativeSessionId).toBe('b');
    now = 30;
    await expectCatalogError(async () => (await catalog.page({ cursor: second.nextCursor })), 'cursor_expired', 409);
  });

  it('evicts the oldest view after 16 concurrent traversals even if that view was recently read', async () => {
    const catalog = new RemoteHostCatalog({ roots: () => [summary('a'), summary('b'), summary('c')], now: () => 0 });
    const pages = await Promise.all(Array.from({ length: 16 }, () => catalog.page({ limit: 1 })));
    (await catalog.page({ cursor: pages[0].nextCursor }));
    (await catalog.page({ limit: 1 }));
    await expectCatalogError(async () => (await catalog.page({ cursor: pages[0].nextCursor })), 'cursor_expired', 409);
    expect((await catalog.page({ cursor: pages[1].nextCursor })).items[0].nativeSessionId).toBe('b');
  });

  it('evicts retained views to respect the shared metadata byte budget', async () => {
    const roots = [summary('a', { title: '\u7532'.repeat(150) }), summary('b', { title: '\u4e59'.repeat(150) })];
    const catalog = new RemoteHostCatalog({ roots: () => roots, maxViewBytes: 2000 });
    const first = (await catalog.page({ limit: 1 }));
    const second = (await catalog.page({ limit: 1 }));
    await expectCatalogError(async () => (await catalog.page({ cursor: first.nextCursor })), 'cursor_expired', 409);
    expect((await catalog.page({ cursor: second.nextCursor })).items[0].nativeSessionId).toBe('b');
  });

  it('rejects a single oversized view without evicting an existing usable view', async () => {
    let roots = [summary('a'), summary('b')];
    const catalog = new RemoteHostCatalog({ roots: () => roots, maxViewBytes: 1000 });
    const first = (await catalog.page({ limit: 1 }));
    roots = [summary('a', { title: 'x'.repeat(2000) }), summary('b')];
    await expectCatalogError(async () => (await catalog.page({ limit: 1 })), 'capacity_exceeded', 429);
    expect((await catalog.page({ cursor: first.nextCursor })).items[0].nativeSessionId).toBe('b');
  });

  it('enforces the default 16 MiB shared metadata budget', async () => {
    const roots = [summary('a', { title: 'x'.repeat(9 * 1024 * 1024) }), summary('b')];
    const catalog = new RemoteHostCatalog({ roots: () => roots });
    const first = (await catalog.page({ limit: 1 }));
    const second = (await catalog.page({ limit: 1 }));
    await expectCatalogError(async () => (await catalog.page({ cursor: first.nextCursor })), 'cursor_expired', 409);
    expect((await catalog.page({ cursor: second.nextCursor })).items[0].nativeSessionId).toBe('b');
  });

  it('accepts 100 items and carries a custom page size into omitted continuation limits', async () => {
    const catalog = new RemoteHostCatalog({ roots: () => Array.from({ length: 205 }, (_, index) => summary(String(index).padStart(3, '0'))) });
    const first = (await catalog.page({ limit: 100 }));
    expect(first.items).toHaveLength(100);
    expect((await catalog.page({ cursor: first.nextCursor })).items).toHaveLength(100);
    await expectCatalogError(async () => (await catalog.page({ cursor: first.nextCursor, limit: 30 })), 'invalid_request', 400);
    expect((await catalog.page({ cursor: first.nextCursor, limit: 100 })).items[0].nativeSessionId).toBe('100');
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity, '30', null])('rejects invalid limit %j', async (limit) => {
    const catalog = new RemoteHostCatalog({ roots: () => [summary('a')] });
    await expectCatalogError(async () => (await catalog.page({ limit: limit as number })), 'invalid_request', 400);
  });

  it.each(['', 'not-a-cursor', ' '.repeat(20), 'a'.repeat(1025), 3, null])('rejects malformed cursor %j', async (cursor) => {
    const catalog = new RemoteHostCatalog({ roots: () => [summary('a')] });
    await expectCatalogError(async () => (await catalog.page({ cursor: cursor as string })), 'invalid_request', 400);
  });

  it('isolates cursor and revision namespaces between catalog instances', async () => {
    const roots = () => [summary('a'), summary('b')];
    const first = new RemoteHostCatalog({ roots });
    const second = new RemoteHostCatalog({ roots });
    expect((await first.revision())).not.toBe((await second.revision()));
    const page = (await first.page({ limit: 1 }));
    await expectCatalogError(async () => (await second.page({ cursor: page.nextCursor })), 'cursor_expired', 409);
    expect((await first.page({ cursor: page.nextCursor })).items[0].nativeSessionId).toBe('b');
  });

  it('returns an empty page without a continuation', async () => {
    const catalog = new RemoteHostCatalog({ roots: () => [] });
    expect((await catalog.page())).toEqual({ items: [], hasMore: false, revision: (await catalog.revision()) });
  });

  it('retires cursors and stops reading roots when disposed', async () => {
    let disposed = false;
    const catalog = new RemoteHostCatalog({ roots: () => {
      if (disposed) throw new Error('A disposed catalog cannot read native state.');
      return [summary('a'), summary('b')];
    } });
    const first = (await catalog.page({ limit: 1 }));
    catalog.dispose();
    catalog.dispose();
    disposed = true;
    await expectCatalogError(async () => (await catalog.page({ cursor: first.nextCursor })), 'cursor_expired', 409);
    await expectCatalogError(async () => (await catalog.page()), 'cursor_expired', 409);
    await expectCatalogError(async () => (await catalog.revision()), 'cursor_expired', 409);
  });
});
