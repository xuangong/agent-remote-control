import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { sessionKey } from '../session-tree.js';
import { useAskConversations } from './useAskConversations.js';

const baseUrl = 'http://localhost/';
const source = { agentId: 'source-agent', nativeSessionId: 'source-native', providerId: 'codex', hostId: 'local', title: 'Source' };
const state = { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [] } } };
afterEach(() => { conversationLocalStorage.clear(); conversationSessionStorage.clear(); localStorage.clear(); sessionStorage.clear(); });

async function setup() {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let attachError: { message: string; status: number; code?: string } | undefined;
  let createError: string | undefined;
  let attachPause: Promise<void> | undefined;
  const directory = new SessionDirectoryClient(baseUrl, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path.endsWith('/attach') && attachPause) { const pending = attachPause; attachPause = undefined; await pending; }
    if (path.endsWith('/attach') && attachError) return Response.json({ error: attachError.message, code: attachError.code }, { status: attachError.status });
    if (path.endsWith('/create') && createError) return Response.json({ error: createError }, { status: 504 });
    return Response.json({ agentId: path.endsWith('/attach') ? 'restored-agent' : 'created-agent', nativeSessionId: body.nativeSessionId ?? 'ask-native' });
  });
  let ask!: ReturnType<typeof useAskConversations>;
  function Harness() { ask = useAskConversations(baseUrl, {} as never, directory); return null; }
  let container = await render(<Harness />);
  await act(async () => { await ask.open(state, source); ask.setDraft(sessionKey(source), 'Unsent Ask draft'); });
  return { requests, current: () => ask, failAttach: (message?: string, status = 503, code?: string) => { attachError = message ? { message, status, code } : undefined; },
    failCreate: (message?: string) => { createError = message; },
    pauseAttach: () => { let finish!: () => void; attachPause = new Promise<void>(resolve => { finish = resolve; }); return finish; },
    reload: async () => { await unmount(container); container = await render(<Harness />); return container; } };
}

it('restores an expanded source-bound Ask and draft without creating another native session', async () => {
  const fixture = await setup();
  await fixture.reload();
  const ask = fixture.current();
  expect(ask.isOpen(source)).toBe(true);
  expect(ask.drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  await act(async () => { ask.restore(source, async () => {}); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, record: {
    source, target: { agentId: 'restored-agent', nativeSessionId: 'ask-native', providerId: 'codex', hostId: 'local' },
  } });
  expect(fixture.requests).toEqual([
    expect.objectContaining({ path: '/v1/remote/create' }),
    { path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } },
  ]);
});

it('retries a saved Ask without waiting for its source snapshot', async () => {
  const fixture = await setup();
  fixture.failAttach('Ask is temporarily unavailable');
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}); });
  expect(fixture.current().entryFor(source).error).toBe('Ask is temporarily unavailable');
  fixture.failAttach();
  await act(async () => { await fixture.current().open(undefined, source); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, restoring: false });
  expect(fixture.requests).toEqual([
    expect.objectContaining({ path: '/v1/remote/create' }),
    { path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } },
    { path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } },
  ]);
});

it('requires the source snapshot for Clean and retains the existing Ask when it is unavailable', async () => {
  const fixture = await setup();
  await act(async () => { await expect(fixture.current().open(undefined, source, '', true)).rejects.toThrow('Open the source session'); });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.current().entryFor(source)).toMatchObject({ busy: false, attached: true, record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('invalidates a previous attachment when the native Ask is unavailable and retains its identity and draft for Retry', async () => {
  const fixture = await setup();
  expect(fixture.current().entryFor(source).attached).toBe(true);
  fixture.failAttach('The native runtime could not find this session.', 404, 'native_session_unavailable');
  await act(async () => { await expect(fixture.current().open(undefined, source)).rejects.toThrow('could not find this session'); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: false, busy: false,
    error: 'The native runtime could not find this session.', record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  await act(async () => { fixture.current().restore(source, async () => {}); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/attach']);
  fixture.failAttach();
  await act(async () => { await fixture.current().open(undefined, source); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, error: undefined });
  expect(fixture.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } });
});

it('retains the attached Ask when an attempted Clean fails to create its replacement', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true)).rejects.toThrow('Creation outcome is unknown'); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it.each(['minimize', 'disable'])('keeps Ask closed after %s and reload while retaining its identity and draft', async action => {
  const fixture = await setup();
  await act(async () => { if (action === 'minimize') fixture.current().close(source); else fixture.current().toggle(source); });
  await fixture.reload();
  expect(fixture.current().isOpen(source)).toBe(false);
  expect(fixture.current().entryFor(source).record?.target?.nativeSessionId).toBe('ask-native');
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('retains the saved native identity after a failed restoration and only retries when requested', async () => {
  const fixture = await setup();
  fixture.failAttach('Recorded reconnect unavailable');
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}); });
  expect(fixture.current().entryFor(source)).toMatchObject({ error: 'Recorded reconnect unavailable', record: { target: { nativeSessionId: 'ask-native' } } });
  await act(async () => { fixture.current().restore(source, async () => {}); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/attach']);
  fixture.failAttach();
  await act(async () => { await fixture.current().open(state, source); });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, error: undefined, record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } });
});

it('waits for shared Ask relations before reconnecting a record discovered on another page', async () => {
  const fixture = await setup();
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('agent-remote-forks:ask:')) sessionStorage.removeItem(key);
  await fixture.reload();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => { fixture.current().restore(source, async () => {
    await ready;
    fixture.current().store.setSharedRelations([{ id: 'shared-ask', kind: 'ask', createdAt: '2026-10-08T00:00:00.000Z', source,
      target: { ...source, agentId: 'shared-agent', nativeSessionId: 'shared-native', title: 'Shared Ask' } }]);
  }); });
  expect(fixture.requests).toHaveLength(1);
  await act(async () => finish());
  expect(fixture.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'shared-native' } });
  expect(fixture.current().entryFor(source).record?.target?.nativeSessionId).toBe('shared-native');
});

it('retains the open Ask and its draft when an explicit relation check fails', async () => {
  const fixture = await setup();
  await act(async () => { fixture.current().close(source); });
  await act(async () => {
    await expect(fixture.current().open(state, source, '', false, {
      synchronize: async () => { throw new Error('Related sessions could not be checked'); },
    })).rejects.toThrow('Related sessions could not be checked');
  });
  expect(fixture.current().isOpen(source)).toBe(true);
  expect(fixture.current().entryFor(source)).toMatchObject({ busy: false, error: 'Related sessions could not be checked' });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  expect(fixture.requests).toHaveLength(1);
});

it('releases a cancelled opening before its shared relation query finishes', async () => {
  const fixture = await setup();
  await act(async () => { fixture.current().close(source); });
  let finish!: () => void;
  const relations = new Promise<void>(resolve => { finish = resolve; });
  let opening!: Promise<unknown>;
  await act(async () => { opening = fixture.current().open(state, source, '', false, { synchronize: () => relations }); });
  expect(fixture.current().entryFor(source).busy).toBe(true);
  await act(async () => { fixture.current().close(source); });
  expect(fixture.current().entryFor(source).busy).toBe(false);
  await act(async () => { await fixture.current().open(state, source, '', false, { synchronize: async () => {} }); });
  expect(fixture.current().entryFor(source).attached).toBe(true);
  await act(async () => { finish(); await opening; });
  expect(fixture.current().isOpen(source)).toBe(true);
  expect(fixture.requests.filter(item => item.path.endsWith('/attach'))).toHaveLength(1);
});

it('keeps an uncertain creation identity when a relation check discovers another Ask', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true)).rejects.toThrow('Creation outcome is unknown'); });
  const operationId = fixture.current().entryFor(source).pending!.id;
  fixture.failCreate();
  await act(async () => {
    await fixture.current().open(state, source, '', false, { synchronize: async () => {
      fixture.current().store.setSharedRelations([{ id: 'other-ask', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
        target: { ...source, agentId: 'other-agent', nativeSessionId: 'other-native', title: 'Other Ask' } }]);
    } });
  });
  expect(fixture.requests.at(-1)).toMatchObject({ path: '/v1/remote/create', body: { operationId } });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, pending: undefined, record: { id: operationId } });
});

it.each(['failed', 'missing'])('does not create a replacement when restored relations are %s', async outcome => {
  const fixture = await setup();
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('agent-remote-forks:ask:')) sessionStorage.removeItem(key);
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {
    if (outcome === 'failed') throw new Error('Related sessions could not be checked');
  }); });
  expect(fixture.current().entryFor(source).error).toBeTruthy();
  expect(fixture.current().isOpen(source)).toBe(true);
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  expect(fixture.requests).toHaveLength(1);
});

it('keeps explicit Retry restore-only when the saved record is unavailable until Clean is chosen', async () => {
  const fixture = await setup();
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('agent-remote-forks:ask:')) sessionStorage.removeItem(key);
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}); });
  await act(async () => { await expect(fixture.current().open(state, source)).rejects.toThrow('saved Ask session'); });
  expect(fixture.requests).toHaveLength(1);
  await act(async () => { await fixture.current().open(state, source, '', true); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/create']);
});

it('only retries an uncertain saved creation explicitly with its original operation identity', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true)).rejects.toThrow('Creation outcome is unknown'); });
  const operationId = fixture.current().entryFor(source).pending!.id;
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}); });
  expect(fixture.current().entryFor(source).error).toContain('saved Ask session');
  expect(fixture.requests).toHaveLength(2);
  fixture.failCreate();
  await act(async () => { await fixture.current().open(state, source); });
  expect(fixture.requests.at(-1)).toMatchObject({ path: '/v1/remote/create', body: { operationId } });
  expect(fixture.current().entryFor(source)).toMatchObject({ attached: true, pending: undefined, record: { id: operationId } });
});

it('cancels a pending restore when minimized without later reopening or attaching', async () => {
  const fixture = await setup();
  await fixture.reload();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => { fixture.current().restore(source, () => ready); });
  await act(async () => fixture.current().close(source));
  await act(async () => finish());
  expect(fixture.current().isOpen(source)).toBe(false);
  expect(fixture.requests).toHaveLength(1);
});

it('resumes restoration after a source switch even while the cancelled relation check is still pending', async () => {
  const fixture = await setup();
  await fixture.reload();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  let cancel: (() => void) | undefined;
  await act(async () => { cancel = fixture.current().restore(source, () => ready); });
  await act(async () => {
    cancel?.();
    fixture.current().restore(source, async () => {});
  });
  expect(fixture.current().entryFor(source).attached).toBe(true);
  await act(async () => finish());
  expect(fixture.requests.filter(item => item.path === '/v1/remote/attach')).toHaveLength(1);
});

it('does not let a retired relation check clear the replacement restoration state', async () => {
  const fixture = await setup();
  await fixture.reload();
  let finishOld!: () => void, finishNew!: () => void;
  const oldReady = new Promise<void>(resolve => { finishOld = resolve; });
  const newReady = new Promise<void>(resolve => { finishNew = resolve; });
  let cancel: (() => void) | undefined;
  await act(async () => { cancel = fixture.current().restore(source, () => oldReady); });
  await act(async () => { cancel?.(); fixture.current().restore(source, () => newReady); });
  await act(async () => finishOld());
  expect(fixture.current().entryFor(source).restoring).toBe(true);
  await act(async () => finishNew());
  expect(fixture.current().entryFor(source)).toMatchObject({ restoring: false, attached: true });
});

it.each([false, true])('keeps queued restoration owned by its source selection when cancelled is %s', async cancelled => {
  const fixture = await setup();
  await fixture.reload();
  const finishAttach = fixture.pauseAttach();
  let cancelOld: (() => void) | undefined, cancelNew: (() => void) | undefined;
  await act(async () => { cancelOld = fixture.current().restore(source, async () => {}); });
  expect(fixture.requests.filter(item => item.path === '/v1/remote/attach')).toHaveLength(1);
  await act(async () => { cancelOld?.(); cancelNew = fixture.current().restore(source, async () => {}); });
  expect(fixture.current().entryFor(source).restoring).toBe(true);
  await act(async () => { if (cancelled) cancelNew?.(); finishAttach(); });
  expect(fixture.requests.filter(item => item.path === '/v1/remote/attach')).toHaveLength(cancelled ? 1 : 2);
  expect(fixture.current().entryFor(source).attached).toBe(cancelled ? undefined : true);
});

it('leaves another Host with the same native source untouched during restoration', async () => {
  const fixture = await setup();
  await fixture.reload();
  await act(async () => { fixture.current().restore({ ...source, hostId: 'other-host' }, async () => {}); });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.current().isOpen(source)).toBe(true);
});

it('keeps the expanded-window state off disk when clear-on-close protection is enabled', async () => {
  localStorage.setItem('agent-remote:clear-cache-on-close', 'true');
  const fixture = await setup();
  expect(fixture.current().isOpen(source)).toBe(true);
  expect(Object.keys(sessionStorage).filter(key => key.startsWith('agent-remote-ask:'))).toEqual([]);
  expect(Object.keys(localStorage).filter(key => key.startsWith('agent-remote-ask:'))).toEqual([]);
});

const secondSource = { ...source, agentId: 'second-agent', nativeSessionId: 'second-native', title: 'Second' };
it('keeps two source-bound Ask windows and preferences independent across reload', async () => {
  const fixture = await setup();
  await act(async () => { await fixture.current().open(state, secondSource); });
  expect(fixture.current().isOpen(source)).toBe(true);
  expect(fixture.current().isOpen(secondSource)).toBe(true);
  await fixture.reload();
  await act(async () => {
    fixture.current().restore(source, async () => {});
    fixture.current().restore(secondSource, async () => {});
  });
  expect(fixture.current().entryFor(source).attached).toBe(true);
  expect(fixture.current().entryFor(secondSource).attached).toBe(true);
  await act(async () => { fixture.current().toggle(source); });
  expect(fixture.current().isEnabled(source)).toBe(false);
  expect(fixture.current().isEnabled(secondSource)).toBe(true);
  expect(fixture.current().isOpen(secondSource)).toBe(true);
  await fixture.reload();
  expect(fixture.current().isOpen(source)).toBe(false);
  expect(fixture.current().isOpen(secondSource)).toBe(true);
  expect(fixture.current().isEnabled(source)).toBe(false);
  expect(fixture.current().isEnabled(secondSource)).toBe(true);
  expect(fixture.requests.filter(request => request.path.endsWith('/create'))).toHaveLength(2);
});

it('minimizes one source without cancelling another source restoration', async () => {
  const fixture = await setup();
  await act(async () => { await fixture.current().open(state, secondSource); });
  await fixture.reload();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => {
    fixture.current().restore(source, () => pending);
    fixture.current().restore(secondSource, () => pending);
    fixture.current().close(source);
  });
  await act(async () => { finish(); });
  expect(fixture.current().entryFor(source).attached).not.toBe(true);
  expect(fixture.current().entryFor(secondSource).attached).toBe(true);
  expect(fixture.current().isOpen(source)).toBe(false);
  expect(fixture.current().isOpen(secondSource)).toBe(true);
});
