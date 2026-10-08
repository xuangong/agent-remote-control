import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { useAskConversations } from './useAskConversations.js';
import { useSessionRelations } from './useSessionRelations.js';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';

const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const relation = (kind: 'side' | 'ask'): SessionRelation => ({ id: kind, kind, createdAt: '2026-09-29T00:00:00.000Z', source,
  target: { ...source, nativeSessionId: kind, agentId: kind + '-agent', title: kind } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

it('refreshes both navigation kinds on foreground without persisting remote delivery records', async () => {
  vi.useFakeTimers();
  const sides = new ForkStore('sides'); const asks = new ForkStore('asks', sessionStorage);
  let shared: SessionRelation[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ relations: shared })));
  function Harness() { useSessionRelations('http://localhost/u/alice/', true, sides, asks, 'main'); return null; }
  await render(<Harness />);
  expect(sides.all()).toEqual([]);
  shared = [relation('side'), relation('ask')];
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(150); });
  expect(sides.all().map(item => item.id)).toEqual(['side']);
  expect(asks.all().map(item => item.id)).toEqual(['ask']);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  shared = [];
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(150); });
  expect(sides.all()).toEqual([]); expect(asks.all()).toEqual([]);
});

it('imports only verified navigation fields from both older local ledgers and deduplicates them', async () => {
  const sides = new ForkStore('old-side'); const asks = new ForkStore('old-ask', sessionStorage);
  const imports: Record<string, unknown>[] = []; const shared: SessionRelation[] = [];
  for (const [store, kind] of [[sides, 'side'], [asks, 'ask']] as const) {
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, relation(kind).target); store.markConfigured(record.id);
    await store.send(record.id, 'Do not upload this message', async () => {}, async () => true);
  }
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body)); imports.push(input);
      shared.push({ ...relation(input.kind), id: input.id, createdAt: input.createdAt });
    }
    return Response.json({ relations: shared });
  }));
  let refresh!: () => Promise<void>;
  function Harness() { refresh = useSessionRelations('http://localhost/u/alice/', true, sides, asks, 'main'); return null; }
  await render(<Harness />);
  await act(refresh);
  expect(imports.map(item => item.kind)).toEqual(['side', 'ask']);
  expect(JSON.stringify(imports)).not.toContain('Do not upload');
  expect(imports.every(item => !('settings' in item) && !('options' in item))).toBe(true);
  expect(sides.all()).toHaveLength(1); expect(asks.all()).toHaveLength(1);
  expect(sides.all()[0]?.remote).toBeUndefined();
  await act(refresh); expect(imports).toHaveLength(2);
});

it('reports an unavailable directory before an explicit Ask open can accidentally create a replacement', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
  const sides = new ForkStore('sides'); const asks = new ForkStore('asks');
  let refresh!: () => Promise<void>;
  function Harness() { refresh = useSessionRelations('http://localhost/u/alice/', true, sides, asks, 'main'); return null; }
  await render(<Harness />);
  await expect(refresh()).rejects.toThrow('Related sessions could not be checked');
});


it('lets the first Ask toggle hide an automatically discovered entry and the next toggle restore it', async () => {
  let ask!: ReturnType<typeof useAskConversations>;
  function Harness() { ask = useAskConversations('http://localhost/u/alice/', {} as never); return null; }
  await render(<Harness />);
  await act(async () => ask.store.setSharedRelations([relation('ask')]));
  expect(ask.entryFor(source).record?.remote).toBe(true);
  expect(ask.isEnabled(source)).toBe(true);
  await act(async () => ask.toggle(source));
  expect(ask.isEnabled(source)).toBe(false);
  await act(async () => ask.toggle(source));
  expect(ask.isEnabled(source)).toBe(true);
});

it('keeps a pending Ask relation recovery alive when focus moves to a sibling view', async () => {
  const baseUrl = 'http://localhost/';
  sessionStorage.setItem(`agent-remote-ask:${baseUrl}:open-windows`, JSON.stringify([sessionKey(source)]));
  localStorage.setItem(`agent-remote-ask:${baseUrl}:enabled:${sessionKey(source)}`, 'true');
  let finish!: () => void;
  let relationSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const fetchRelations = vi.fn(async (_url: unknown, init?: RequestInit) => {
    relationSignal = init?.signal ?? undefined;
    await ready;
    relationSignal?.throwIfAborted();
    return Response.json({ relations: [relation('ask')] });
  });
  vi.stubGlobal('fetch', fetchRelations);
  const attach = vi.fn(async () => Response.json({ agentId: 'restored-ask', nativeSessionId: 'ask' }));
  const directory = new SessionDirectoryClient(baseUrl, attach);
  const sides = new ForkStore('relation-focus');
  let ask!: ReturnType<typeof useAskConversations>, refresh!: () => Promise<void>, focus!: (key: string) => void;
  function Harness() {
    const [current, setCurrent] = useState('main'); focus = setCurrent;
    ask = useAskConversations(baseUrl, {} as never, directory, 'host');
    refresh = useSessionRelations(baseUrl, true, sides, ask.store, current);
    return null;
  }
  await render(<Harness />);
  await act(async () => { ask.restore(source, refresh); });
  await act(async () => { focus('side'); });
  expect(relationSignal?.aborted).toBe(false);
  expect(ask.entryFor(source).error).toBeUndefined();
  await act(async () => { finish(); });
  expect(ask.entryFor(source)).toMatchObject({ attached: true, restoring: false });
  expect(attach).toHaveBeenCalledTimes(1);
  expect(fetchRelations).toHaveBeenCalledTimes(1);
});
