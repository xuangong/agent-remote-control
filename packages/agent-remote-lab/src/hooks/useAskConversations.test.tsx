import { configureImageDraftPersistence } from '@orchardworks/agent-remote-web/browser';
import { act, StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { sessionKey } from '../session-tree.js';
import { useAskConversations } from './useAskConversations.js';
import { currentForkSource, referenceForkContext } from '../session-forks.js';
import { compositionRoleKey, createCompositionSlot, createAskOwner, initializeCompositionDocument, type CompositionDocument } from '../session-composition.js';

const baseUrl = 'http://localhost/';
const source = { agentId: 'source-agent', nativeSessionId: 'source-native', providerId: 'codex', hostId: 'local', title: 'Source' };
const state = { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [] } } };
beforeEach(() => configureImageDraftPersistence(() => false));
afterEach(() => configureImageDraftPersistence(() => true));
let viewDocument: CompositionDocument | undefined;
function fixtureDocument() {
  if (!viewDocument) {
    const read = initializeCompositionDocument(baseUrl);
    if (read.status !== 'ready') throw new Error('Fixture composition unavailable.');
    viewDocument = read.document;
  }
  return viewDocument;
}
function fixtureOwner(value: typeof source) {
  const document = fixtureDocument(), key = sessionKey(value);
  let owner = document.asks.find(owner => owner.text.key === key);
  if (!owner) {
    const slot = createCompositionSlot(`fixture:${key}`, value, baseUrl);
    document.slots.push(slot);
    owner = { ...createAskOwner(slot, baseUrl), id: key, text: { scope: `${baseUrl}:ask`, key },
      input: { scope: baseUrl, key: `agent-remote-ask:${baseUrl}:inputs:${key}` } };
    document.asks.push(owner); document.editRevision++;
  }
  return owner;
}
const ownerId = (value: typeof source) => fixtureOwner(value).id;
afterEach(() => { viewDocument = undefined; conversationLocalStorage.clear(); conversationSessionStorage.clear(); localStorage.clear(); sessionStorage.clear(); });

async function setup(transport = {} as import('@orchardworks/agent-remote-web').RemoteAgentTransport) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let attachError: { message: string; status: number; code?: string } | undefined;
  let createError: string | undefined;
  let attachPause: Promise<void> | undefined;
  let rerender!: () => void;
  let activeTransport = transport;
  let createPause: Promise<void> | undefined;
  const directory = new SessionDirectoryClient(baseUrl, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path.endsWith('/attach') && attachPause) { const pending = attachPause; attachPause = undefined; await pending; }
    if (path.endsWith('/create') && createPause) { const pending = createPause; createPause = undefined; await pending; }
    if (path.endsWith('/attach') && attachError) return Response.json({ error: attachError.message, code: attachError.code }, { status: attachError.status });
    if (path.endsWith('/create') && createError) return Response.json({ error: createError }, { status: 504 });
    return Response.json({ agentId: path.endsWith('/attach') ? 'restored-agent' : 'created-agent', nativeSessionId: body.nativeSessionId ?? 'ask-native' });
  });
  let ask!: ReturnType<typeof useAskConversations>;
  function Harness() { const [, changed] = useState(0); rerender = () => changed(value => value + 1); ask = useAskConversations(fixtureDocument(), activeTransport, directory); return null; }
  let container = await render(<Harness />);
  await act(async () => { await ask.open(state, source, '', false, { associationOwner: ownerId(source) }); ask.setDraft(ownerId(source), 'Unsent Ask draft'); });
  return { requests, current: () => ask, failAttach: (message?: string, status = 503, code?: string) => { attachError = message ? { message, status, code } : undefined; },
    failCreate: (message?: string) => { createError = message; },
    pauseAttach: () => { let finish!: () => void; attachPause = new Promise<void>(resolve => { finish = resolve; }); return finish; },
    replaceTransport: () => { activeTransport = {} as typeof transport; rerender(); },
    pauseCreate: () => { let finish!: () => void; createPause = new Promise<void>(resolve => { finish = resolve; }); return finish; },
    reload: async () => { await unmount(container); viewDocument = undefined; container = await render(<Harness />); return container; } };
}

it('restores an expanded source-bound Ask and draft without creating another native session', async () => {
  const fixture = await setup();
  await fixture.reload();
  const ask = fixture.current();
  expect(ask.isOpen(source, ownerId(source))).toBe(true);
  expect(ask.drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  await act(async () => { ask.restore(source, async () => {}, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, record: {
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
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source)).error).toBe('Ask is temporarily unavailable');
  fixture.failAttach();
  await act(async () => { await fixture.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, restoring: false });
  expect(fixture.requests).toEqual([
    expect.objectContaining({ path: '/v1/remote/create' }),
    { path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } },
    { path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } },
  ]);
});

it('requires the source snapshot for Clean and retains the existing Ask when it is unavailable', async () => {
  const fixture = await setup();
  await act(async () => { await expect(fixture.current().open(undefined, source, '', true, { associationOwner: ownerId(source) })).rejects.toThrow('Open the source session'); });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ busy: false, attached: true, record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('invalidates a previous attachment when the native Ask is unavailable and retains its identity and draft for Retry', async () => {
  const fixture = await setup();
  expect(fixture.current().entryFor(source, ownerId(source)).attached).toBe(true);
  fixture.failAttach('The native runtime could not find this session.', 404, 'native_session_unavailable');
  await act(async () => { await expect(fixture.current().open(undefined, source, '', false, { associationOwner: ownerId(source) })).rejects.toThrow('could not find this session'); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: false, busy: false,
    error: 'The native runtime could not find this session.', record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/attach']);
  fixture.failAttach();
  await act(async () => { await fixture.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, error: undefined });
  expect(fixture.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } });
});

it('retains the attached Ask when an attempted Clean fails to create its replacement', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true, { associationOwner: ownerId(source) })).rejects.toThrow('Creation outcome is unknown'); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, record: { target: { nativeSessionId: 'ask-native' } } });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it.each(['minimize', 'disable'])('keeps Ask closed after %s and reload while retaining its identity and draft', async action => {
  const fixture = await setup();
  await act(async () => { if (action === 'minimize') fixture.current().close(source, ownerId(source)); else fixture.current().toggle(source, ownerId(source)); });
  await fixture.reload();
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(false);
  expect(fixture.current().entryFor(source, ownerId(source)).record?.target?.nativeSessionId).toBe('ask-native');
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('retains the saved native identity after a failed restoration and only retries when requested', async () => {
  const fixture = await setup();
  fixture.failAttach('Recorded reconnect unavailable');
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ error: 'Recorded reconnect unavailable', record: { target: { nativeSessionId: 'ask-native' } } });
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/attach']);
  fixture.failAttach();
  await act(async () => { await fixture.current().open(state, source, '', false, { associationOwner: ownerId(source) }); });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, error: undefined, record: { target: { nativeSessionId: 'ask-native' } } });
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
  }, ownerId(source)); });
  expect(fixture.requests).toHaveLength(1);
  await act(async () => finish());
  expect(fixture.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'shared-native' } });
  expect(fixture.current().entryFor(source, ownerId(source)).record?.target?.nativeSessionId).toBe('shared-native');
});

it('retains the open Ask and its draft when an explicit relation check fails', async () => {
  const fixture = await setup();
  await act(async () => { fixture.current().close(source, ownerId(source)); });
  await act(async () => {
    await expect(fixture.current().open(state, source, '', false, { ...{
      synchronize: async () => { throw new Error('Related sessions could not be checked'); },
    }, associationOwner: ownerId(source) })).rejects.toThrow('Related sessions could not be checked');
  });
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ busy: false, error: 'Related sessions could not be checked' });
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  expect(fixture.requests).toHaveLength(1);
});

it('releases a cancelled opening before its shared relation query finishes', async () => {
  const fixture = await setup();
  await act(async () => { fixture.current().close(source, ownerId(source)); });
  let finish!: () => void;
  const relations = new Promise<void>(resolve => { finish = resolve; });
  let opening!: Promise<unknown>;
  await act(async () => { opening = fixture.current().open(state, source, '', false, { ...{ synchronize: () => relations }, associationOwner: ownerId(source) }); });
  expect(fixture.current().entryFor(source, ownerId(source)).busy).toBe(true);
  await act(async () => { fixture.current().close(source, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source)).busy).toBe(false);
  await act(async () => { await fixture.current().open(state, source, '', false, { ...{ synchronize: async () => {} }, associationOwner: ownerId(source) }); });
  expect(fixture.current().entryFor(source, ownerId(source)).attached).toBe(true);
  await act(async () => { finish(); await opening; });
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
  expect(fixture.requests.filter(item => item.path.endsWith('/attach'))).toHaveLength(1);
});

it('keeps an uncertain creation identity when a relation check discovers another Ask', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true, { associationOwner: ownerId(source) })).rejects.toThrow('Creation outcome is unknown'); });
  const operationId = fixture.current().entryFor(source, ownerId(source)).pending!.id;
  fixture.failCreate();
  await act(async () => {
    await fixture.current().open(state, source, '', false, { ...{ synchronize: async () => {
      fixture.current().store.setSharedRelations([{ id: 'other-ask', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
        target: { ...source, agentId: 'other-agent', nativeSessionId: 'other-native', title: 'Other Ask' } }]);
    } }, associationOwner: ownerId(source) });
  });
  expect(fixture.requests.at(-1)).toMatchObject({ path: '/v1/remote/create', body: { operationId } });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, pending: undefined, record: { id: operationId } });
});

it.each(['failed', 'missing'])('does not create a replacement when restored relations are %s', async outcome => {
  const fixture = await setup();
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('agent-remote-forks:ask:')) sessionStorage.removeItem(key);
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {
    if (outcome === 'failed') throw new Error('Related sessions could not be checked');
  }, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source)).error).toBeTruthy();
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
  expect(fixture.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  expect(fixture.requests).toHaveLength(1);
});

it('keeps explicit Retry restore-only when the saved record is unavailable until Clean is chosen', async () => {
  const fixture = await setup();
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('agent-remote-forks:ask:')) sessionStorage.removeItem(key);
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  await act(async () => { await expect(fixture.current().open(state, source, '', false, { associationOwner: ownerId(source) })).rejects.toThrow('saved Ask session'); });
  expect(fixture.requests).toHaveLength(1);
  await act(async () => { await fixture.current().open(state, source, '', true, { associationOwner: ownerId(source) }); });
  expect(fixture.requests.map(item => item.path)).toEqual(['/v1/remote/create', '/v1/remote/create']);
});

it('only retries an uncertain saved creation explicitly with its original operation identity', async () => {
  const fixture = await setup();
  fixture.failCreate('Creation outcome is unknown');
  await act(async () => { await expect(fixture.current().open(state, source, '', true, { associationOwner: ownerId(source) })).rejects.toThrow('Creation outcome is unknown'); });
  const operationId = fixture.current().entryFor(source, ownerId(source)).pending!.id;
  await fixture.reload();
  await act(async () => { fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source)).error).toContain('saved Ask session');
  expect(fixture.requests).toHaveLength(2);
  fixture.failCreate();
  await act(async () => { await fixture.current().open(state, source, '', false, { associationOwner: ownerId(source) }); });
  expect(fixture.requests.at(-1)).toMatchObject({ path: '/v1/remote/create', body: { operationId } });
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, pending: undefined, record: { id: operationId } });
});

it('cancels a pending restore when minimized without later reopening or attaching', async () => {
  const fixture = await setup();
  await fixture.reload();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => { fixture.current().restore(source, () => ready, ownerId(source)); });
  await act(async () => fixture.current().close(source, ownerId(source)));
  await act(async () => finish());
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(false);
  expect(fixture.requests).toHaveLength(1);
});

it('resumes restoration after a source switch even while the cancelled relation check is still pending', async () => {
  const fixture = await setup();
  await fixture.reload();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  let cancel: (() => void) | undefined;
  await act(async () => { cancel = fixture.current().restore(source, () => ready, ownerId(source)); });
  await act(async () => {
    cancel?.();
    fixture.current().restore(source, async () => {}, ownerId(source));
  });
  expect(fixture.current().entryFor(source, ownerId(source)).attached).toBe(true);
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
  await act(async () => { cancel = fixture.current().restore(source, () => oldReady, ownerId(source)); });
  await act(async () => { cancel?.(); fixture.current().restore(source, () => newReady, ownerId(source)); });
  await act(async () => finishOld());
  expect(fixture.current().entryFor(source, ownerId(source)).restoring).toBe(true);
  await act(async () => finishNew());
  expect(fixture.current().entryFor(source, ownerId(source))).toMatchObject({ restoring: false, attached: true });
});

it.each([false, true])('keeps queued restoration owned by its source selection when cancelled is %s', async cancelled => {
  const fixture = await setup();
  await fixture.reload();
  const finishAttach = fixture.pauseAttach();
  let cancelOld: (() => void) | undefined, cancelNew: (() => void) | undefined;
  await act(async () => { cancelOld = fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.requests.filter(item => item.path === '/v1/remote/attach')).toHaveLength(1);
  await act(async () => { cancelOld?.(); cancelNew = fixture.current().restore(source, async () => {}, ownerId(source)); });
  expect(fixture.current().entryFor(source, ownerId(source)).restoring).toBe(true);
  await act(async () => { if (cancelled) cancelNew?.(); finishAttach(); });
  expect(fixture.requests.filter(item => item.path === '/v1/remote/attach')).toHaveLength(cancelled ? 1 : 2);
  if (cancelled) expect(fixture.current().entryFor(source, ownerId(source)).attached).not.toBe(true);
  else expect(fixture.current().entryFor(source, ownerId(source)).attached).toBe(true);
});

it('leaves another Host with the same native source untouched during restoration', async () => {
  const fixture = await setup();
  await fixture.reload();
  await act(async () => { fixture.current().restore({ ...source, hostId: 'other-host' }, async () => {}, ownerId({ ...source, hostId: 'other-host' })); });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
});

it('keeps the expanded-window state off disk when clear-on-close protection is enabled', async () => {
  localStorage.setItem('agent-remote:clear-cache-on-close', 'true');
  const fixture = await setup();
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
  expect(Object.keys(sessionStorage).filter(key => key.startsWith('agent-remote-ask:'))).toEqual([]);
  expect(Object.keys(localStorage).filter(key => key.startsWith('agent-remote-ask:'))).toEqual([]);
});

const secondSource = { ...source, agentId: 'second-agent', nativeSessionId: 'second-native', title: 'Second' };
it('keeps two source-bound Ask windows and preferences independent across reload', async () => {
  const fixture = await setup();
  await act(async () => { await fixture.current().open(state, secondSource, '', false, { associationOwner: ownerId(secondSource) }); });
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(true);
  expect(fixture.current().isOpen(secondSource, ownerId(secondSource))).toBe(true);
  await fixture.reload();
  await act(async () => {
    fixture.current().restore(source, async () => {}, ownerId(source));
    fixture.current().restore(secondSource, async () => {}, ownerId(secondSource));
  });
  expect(fixture.current().entryFor(source, ownerId(source)).attached).toBe(true);
  expect(fixture.current().entryFor(secondSource, ownerId(secondSource)).attached).toBe(true);
  await act(async () => { fixture.current().toggle(source, ownerId(source)); });
  expect(fixture.current().isEnabled(source, ownerId(source))).toBe(false);
  expect(fixture.current().isEnabled(secondSource, ownerId(secondSource))).toBe(true);
  expect(fixture.current().isOpen(secondSource, ownerId(secondSource))).toBe(true);
  await fixture.reload();
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(false);
  expect(fixture.current().isOpen(secondSource, ownerId(secondSource))).toBe(true);
  expect(fixture.current().isEnabled(source, ownerId(source))).toBe(false);
  expect(fixture.current().isEnabled(secondSource, ownerId(secondSource))).toBe(true);
  expect(fixture.requests.filter(request => request.path.endsWith('/create'))).toHaveLength(2);
});

it('minimizes one source without cancelling another source restoration', async () => {
  const fixture = await setup();
  await act(async () => { await fixture.current().open(state, secondSource, '', false, { associationOwner: ownerId(secondSource) }); });
  await fixture.reload();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => {
    fixture.current().restore(source, () => pending, ownerId(source));
    fixture.current().restore(secondSource, () => pending, ownerId(secondSource));
    fixture.current().close(source, ownerId(source));
  });
  await act(async () => { finish(); });
  expect(fixture.current().entryFor(source, ownerId(source)).attached).not.toBe(true);
  expect(fixture.current().entryFor(secondSource, ownerId(secondSource)).attached).toBe(true);
  expect(fixture.current().isOpen(source, ownerId(source))).toBe(false);
  expect(fixture.current().isOpen(secondSource, ownerId(secondSource))).toBe(true);
});


it('discovers the original local Ask under its current shared source without moving local draft state', async () => {
  const fixture = await setup();
  const ask = fixture.current();
  const record = ask.entryFor(source, ownerId(source)).record!;
  const current = { ...source, providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  await act(async () => ask.store.setSharedRelations([{ id: record.id, kind: 'ask', createdAt: record.capturedAt, source: current,
    target: { ...record.target!, hostId: 'local' }, nativeSourceRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: source.nativeSessionId }, hostLocator: { hostId: 'local', controllerId: 'installation' } }]));
  const discovered = ask.entryFor(current, ownerId(source)).record!;
  expect(discovered.id).toBe(record.id);
  expect(discovered.source).toEqual(source);
  expect(discovered.target?.nativeSessionId).toBe('ask-native');
  expect(ask.drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
  expect(ask.drafts.get(sessionKey(current))).toBe('');
  expect(fixture.requests).toHaveLength(1);
});

it('attaches the retained local P/X under projected Q/B without rewriting raw creation or uncertain input', async () => {
  const f = await setup();
  const record = f.current().entryFor(source, ownerId(source)).record!;
  await act(async () => { await expect(f.current().store.send(record.id, 'uncertain question', async () => { throw new Error('Lost receipt'); }, async () => false, 'question-operation')).rejects.toThrow('Lost receipt'); });
  const raw = f.current().store.getLocal(record.id)!;
  const current = { ...source, providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent' };
  await act(async () => f.current().store.setSharedRelations([{ id: record.id, kind: 'ask', createdAt: record.capturedAt, source: current,
    target: { ...record.target!, hostId: record.target!.hostId ?? 'local' }, hostLocator: { hostId: 'local', controllerId: 'installation' },
    nativeSourceRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: source.nativeSessionId } }]));
  expect(f.requests).toHaveLength(1);
  await act(async () => { await f.current().open(undefined, current, '', false, { associationOwner: ownerId(source) }); });
  expect(f.requests.at(-1)).toEqual({ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'ask-native' } });
  expect(f.current().store.getLocal(record.id)).toEqual({ ...raw, target: { ...raw.target!, agentId: 'restored-agent' } });
  expect(currentForkSource(f.current().entryFor(current, ownerId(source)).record!)).toEqual(current);
  expect(f.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('retries the checked original no-target operation after displayed-source metadata changes', async () => {
  const f = await setup();
  const options = { conversationKind: 'ask' as const, sourceNativeSessionId: source.nativeSessionId, cwd: '/original', model: 'original-model',
    creationSource: { providerId: 'codex', nativeSessionId: source.nativeSessionId } };
  let pending!: import('../session-forks.js').SessionFork;
  await act(async () => { pending = f.current().store.prepare(referenceForkContext(source), options, [], sessionKey(source)); });
  const entry = f.current().entryFor(source, ownerId(source));
  entry.pending = { ...pending, source: { ...source, providerId: 'claude', nativeSessionId: 'B' }, options: { model: 'projected-model' } };
  entry.source = { ...source, providerId: 'claude', nativeSessionId: 'B' };
  expect(f.requests).toHaveLength(1);
  await act(async () => { await f.current().open(undefined, source, '', false, { ...{ synchronize: async () => {
    f.current().store.setSharedRelations([{ id: 'different-Ask', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source: { ...entry.source, hostId: entry.source.hostId ?? 'local' },
      target: { ...entry.source, hostId: entry.source.hostId ?? 'local', nativeSessionId: 'different-X' } }]);
  } }, associationOwner: ownerId(source) }); });
  expect(f.requests.at(-1)).toMatchObject({ path: '/v1/remote/create', body: { providerId: 'codex', operationId: pending.id, sourceNativeSessionId: source.nativeSessionId, cwd: '/original', model: 'original-model', creationSource: options.creationSource } });
  expect(f.current().store.getLocal(pending.id)).toMatchObject({ source, options, settings: [], target: { providerId: 'codex', hostId: 'local' } });
  expect(f.current().store.allLocal()).toHaveLength(2);
});

it.each(['missing', 'denied', 'malformed'] as const)('rejects explicit retry of a known local operation when its raw read is %s', async failure => {
  const f = await setup();
  f.failCreate('Unknown creation');
  await act(async () => { await expect(f.current().open(state, source, '', true, { associationOwner: ownerId(source) })).rejects.toThrow('Unknown creation'); });
  const pending = f.current().entryFor(source, ownerId(source)).pending!;
  const read = conversationSessionStorage.getItem.bind(conversationSessionStorage);
  const intercept = vi.spyOn(conversationSessionStorage, 'getItem').mockImplementation(key => {
    if (!key.endsWith(`:record:${pending.id}`)) return read(key);
    if (failure === 'denied') throw new Error('Denied read');
    return failure === 'missing' ? null : '{malformed';
  });
  f.failCreate();
  try {
    await act(async () => { await expect(f.current().open(state, source, '', false, { associationOwner: ownerId(source) })).rejects.toThrow(/unavailable/i); });
    expect(f.requests).toHaveLength(2);
    expect(f.current().entryFor(source, ownerId(source)).pending?.id).toBe(pending.id);
  } finally { intercept.mockRestore(); }
});

it('requires configuration to finish before attachment success and invalidates current Ask on configuration failure', async () => {
  const f = await setup();
  const record = f.current().entryFor(source, ownerId(source)).record!;
  const raw = f.current().store.getLocal(record.id)!;
  conversationSessionStorage.setItem(`agent-remote-forks:ask:${baseUrl}:record:${record.id}`, JSON.stringify({ ...raw, configured: false }));
  const original = f.current().store.markConfigured.bind(f.current().store);
  const mark = vi.spyOn(f.current().store, 'markConfigured').mockImplementation(() => { throw new Error('Configuration could not be saved'); });
  try {
    await act(async () => { await expect(f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) })).rejects.toThrow('Configuration could not be saved'); });
    expect(f.current().entryFor(source, ownerId(source))).toMatchObject({ attached: false, busy: false, record: { id: record.id } });
  } finally { mark.mockRestore(); }
  await act(async () => { original(record.id, true); await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(f.current().entryFor(source, ownerId(source)).attached).toBe(true);
});

it('does not inherit attachment for a same-relation replacement with a different concrete target', async () => {
  const f = await setup();
  await act(async () => f.current().store.setSharedRelations([{ id: 'shared-participant', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
    target: { ...source, nativeSessionId: 'first-X' } }]));
  await act(async () => { f.current().close(source, ownerId(source)); await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); f.current().close(source, ownerId(source)); });
  expect(f.current().entryFor(source, ownerId(source)).attached).toBe(true);
  await act(async () => f.current().store.setSharedRelations([{ id: 'shared-participant', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
    target: { ...source, providerId: 'claude', nativeSessionId: 'first-X' } }]));
  expect(f.current().entryFor(source, ownerId(source)).attached).toBe(false);
  expect(f.current().drafts.get(sessionKey(source))).toBe('Unsent Ask draft');
});

it('retains a late successful create only on its original operation after replacement ownership', async () => {
  const f = await setup();
  const finish = f.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(state, source, 'old question', true, { associationOwner: ownerId(source) }); });
  const original = f.current().entryFor(source, ownerId(source)).pending!;
  await act(async () => f.current().close(source, ownerId(source)));
  const replacement = { ...source, agentId: 'replacement-agent', nativeSessionId: 'replacement-X', title: 'Replacement Ask' };
  const entry = f.current().entryFor(source, ownerId(source));
  entry.record = { ...entry.record!, id: 'replacement-owner', target: replacement };
  entry.pending = undefined;
  entry.attached = true;
  entry.error = 'Replacement error';
  entry.inputs = [{ id: 'replacement-question', text: 'new question' }];
  f.current().setDraft(sessionKey(source), 'Replacement draft');
  const before = { ...entry };
  await act(async () => { finish(); await opening; });
  expect(f.current().store.getLocal(original.id)).toMatchObject({ id: original.id, source, creationKey: sessionKey(source), target: { nativeSessionId: 'ask-native' } });
  expect(f.current().store.getLocal(original.id)?.configured).not.toBe(true);
  expect(f.current().entryFor(source, ownerId(source))).toEqual(before);
  expect(f.current().drafts.get(sessionKey(source))).toBe('Replacement draft');
  expect(f.current().isOpen(source, ownerId(source))).toBe(false);
});

it.each(['missing', 'changed', 'retired'] as const)('does not recreate a late original operation whose raw owner is %s', async failure => {
  const f = await setup();
  const finish = f.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(state, source, '', true, { associationOwner: ownerId(source) }); });
  const original = f.current().entryFor(source, ownerId(source)).pending!;
  const storageKey = `agent-remote-forks:ask:${baseUrl}:record:${original.id}`;
  await act(async () => f.current().close(source, ownerId(source)));
  if (failure === 'missing') conversationSessionStorage.removeItem(storageKey);
  if (failure === 'changed') conversationSessionStorage.setItem(storageKey, JSON.stringify({ ...original, options: { ...original.options, model: 'changed-model' } }));
  if (failure === 'retired') await f.reload();
  await act(async () => { finish(); await opening; });
  expect(f.current().store.getLocal(original.id)?.target).toBeUndefined();
  expect(f.current().isOpen(source, ownerId(source))).toBe(false);
});

it.each(['success', 'failure'] as const)('does not let retired attach %s mutate replacement attachment, questions, error or busy state', async outcome => {
  const f = await setup();
  const finish = f.pauseAttach();
  if (outcome === 'failure') f.failAttach('Old attach failure');
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, 'retired question', false, { associationOwner: ownerId(source) }); });
  await act(async () => f.current().close(source, ownerId(source)));
  const entry = f.current().entryFor(source, ownerId(source));
  entry.record = { ...entry.record!, id: 'replacement-owner', target: { ...source, nativeSessionId: 'replacement-X' } };
  entry.pending = undefined;
  entry.attached = true;
  entry.error = 'Current error';
  entry.inputs = [{ id: 'current-question', text: 'Current question' }];
  const before = { ...entry };
  await act(async () => { finish(); await opening; });
  expect(f.current().entryFor(source, ownerId(source))).toEqual(before);
});

it('retains a completed create and saved question on ordinary close then explicitly resumes the same participant', async () => {
  const f = await setup();
  const finish = f.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(state, source, 'saved question', true, { associationOwner: ownerId(source) }); });
  const originalId = f.current().entryFor(source, ownerId(source)).pending!.id;
  await act(async () => f.current().close(source, ownerId(source)));
  await act(async () => { finish(); await opening; });
  const entry = f.current().entryFor(source, ownerId(source));
  const question = entry.inputs![0]!;
  expect(question).toMatchObject({ text: 'saved question' });
  expect(entry.pending).toMatchObject({ id: originalId, target: { nativeSessionId: 'ask-native' }, creationKey: sessionKey(source) });
  expect(entry.pending?.configured).not.toBe(true);
  expect(f.current().isOpen(source, ownerId(source))).toBe(false);
  await act(async () => { await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(f.current().entryFor(source, ownerId(source))).toMatchObject({ attached: true, pending: undefined, record: { id: originalId } });
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
  const sent: unknown[][] = [];
  await act(async () => { f.current().sendInput(sessionKey(source), question.id, async (...args) => { sent.push(args); }); });
  expect(sent).toEqual([['saved question', question.id]]);
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([]);
  expect(f.requests.map(request => request.path)).toEqual(['/v1/remote/create', '/v1/remote/create', '/v1/remote/attach']);
});

it('does not expose attached success while required configuration waits and does not mutate a replacement after cancellation', async () => {
  const connected: string[] = [];
  const closed: string[] = [];
  const transport: import('@orchardworks/agent-remote-web').RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('Readiness is still pending'); },
    fetchTimeline: async () => { throw new Error('History must not be read'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (agentId, listener) => {
      connected.push(agentId);
      queueMicrotask(() => listener.onOpen());
      return { send: () => {}, close: () => { closed.push(agentId); } };
    },
  };
  const f = await setup(transport);
  const record = f.current().entryFor(source, ownerId(source)).record!;
  const raw = f.current().store.getLocal(record.id)!;
  conversationSessionStorage.setItem(`agent-remote-forks:ask:${baseUrl}:record:${record.id}`,
    JSON.stringify({ ...raw, configured: false, settings: [{ id: 'sandbox', value: 'read-only' }] }));
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, 'old config question', false, { associationOwner: ownerId(source) }); });
  expect(connected).toEqual(['restored-agent']);
  expect(f.current().entryFor(source, ownerId(source)).attached).toBe(false);
  await act(async () => f.current().close(source, ownerId(source)));
  const entry = f.current().entryFor(source, ownerId(source));
  entry.record = { ...entry.record!, id: 'replacement-owner', target: { ...source, nativeSessionId: 'replacement-X' } };
  entry.pending = undefined;
  entry.attached = true;
  entry.error = 'Replacement configuration error';
  entry.inputs = [{ id: 'replacement-question', text: 'Replacement question' }];
  const before = { ...entry };
  await act(async () => { await opening; });
  expect(closed).toEqual(['restored-agent']);
  expect(f.current().entries.get(sessionKey(source))).toEqual(before);
  expect(f.current().store.getLocal(record.id)?.configured).toBe(false);
});

it('does not let a retired restore finalizer clear the replacement restoration state', async () => {
  const f = await setup();
  await f.reload();
  const finish = f.pauseAttach();
  await act(async () => { f.current().restore(source, async () => {}, ownerId(source)); });
  const entry = f.current().entryFor(source, ownerId(source));
  entry.record = { ...entry.record!, id: 'replacement-owner', target: { ...source, nativeSessionId: 'replacement-X' } };
  entry.restoring = true;
  entry.error = 'Replacement restoration error';
  const before = { ...entry };
  await act(async () => finish());
  expect(f.current().entryFor(source, ownerId(source))).toEqual(before);
});

it('rejects a known local attach result when its raw operation disappears instead of binding shared fallback', async () => {
  const f = await setup();
  const record = f.current().entryFor(source, ownerId(source)).record!;
  await act(async () => f.current().store.setSharedRelations([{ id: record.id, kind: 'ask', createdAt: record.capturedAt, source,
    target: { ...record.target!, hostId: 'local' } }]));
  const finish = f.pauseAttach();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  conversationSessionStorage.removeItem(`agent-remote-forks:ask:${baseUrl}:record:${record.id}`);
  await act(async () => { finish(); await expect(opening).rejects.toThrow(/unavailable/i); });
  expect(f.current().store.allLocal()).toEqual([]);
  expect(f.current().entries.get(sessionKey(source))).toMatchObject({ attached: false, error: expect.stringMatching(/unavailable/i) });
  expect(f.current().store.get(record.id).target?.agentId).toBe('created-agent');
});

it('refuses stale saved-question handoff from a retired concrete participant', async () => {
  const f = await setup();
  const entry = f.current().entryFor(source, ownerId(source));
  const previous = JSON.stringify([entry.record!.id, sessionKey(entry.record!.target!)]);
  entry.inputs = [{ id: 'retained-question', text: 'Keep this question' }];
  entry.record = { ...entry.record!, target: { ...entry.record!.target!, providerId: 'claude' } };
  const sent: string[] = [];
  await act(async () => { f.current().sendInput(sessionKey(source), 'retained-question', async text => { sent.push(text); }, previous); });
  expect(sent).toEqual([]);
  expect(f.current().entries.get(sessionKey(source))?.inputs).toEqual([{ id: 'retained-question', text: 'Keep this question' }]);
});

it('opens under StrictMode while a create started by the retired effect probe cannot configure or revive its owner', async () => {
  const requests: { body: Record<string, unknown> }[] = [];
  let finishOld!: () => void;
  const held = new Promise<void>(resolve => { finishOld = resolve; });
  const directory = new SessionDirectoryClient(baseUrl, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ body });
    if (requests.length === 1) await held;
    return Response.json({ agentId: 'strict-agent', nativeSessionId: 'strict-X' });
  });
  const transport = {} as never;
  let ask!: ReturnType<typeof useAskConversations>;
  const probes: Promise<unknown>[] = [];
  function Harness() {
    ask = useAskConversations(fixtureDocument(), transport, directory);
    useEffect(() => {
      if (!probes.length) probes.push(ask.open(state, source, '', false, { associationOwner: ownerId(source) }));
    }, []);
    return null;
  }
  await render(<StrictMode><Harness /></StrictMode>);
  const retiredOperation = requests[0]!.body.operationId as string;
  await act(async () => { finishOld(); await Promise.all(probes); });
  expect(ask.store.getLocal(retiredOperation)?.target).toBeUndefined();
  await act(async () => { await ask.open(state, source, '', false, { associationOwner: ownerId(source) }); });
  expect(ask.entryFor(source, ownerId(source))).toMatchObject({ attached: true, busy: false, record: { target: { nativeSessionId: 'strict-X' } } });
  expect(requests).toHaveLength(2);
});

it('keeps the current pending operation usable after its transport owner retires without accepting the retired create result', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const requests: Record<string, unknown>[] = [];
  const directory = new SessionDirectoryClient(baseUrl, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) await held;
    return Response.json({ agentId: 'new-owner-agent', nativeSessionId: 'owner-X' });
  });
  let ask!: ReturnType<typeof useAskConversations>;
  let retire!: () => void;
  const first = {} as never;
  const second = {} as never;
  function Harness() {
    const [transport, setTransport] = useState(first);
    retire = () => setTransport(second);
    ask = useAskConversations(fixtureDocument(), transport, directory);
    return null;
  }
  await render(<Harness />);
  let opening!: Promise<unknown>;
  await act(async () => { opening = ask.open(state, source, '', false, { associationOwner: ownerId(source) }); });
  const operationId = ask.entryFor(source, ownerId(source)).pending!.id;
  await act(async () => retire());
  await act(async () => { finish(); await opening; });
  expect(ask.store.getLocal(operationId)?.target).toBeUndefined();
  expect(ask.entryFor(source, ownerId(source)).busy).toBe(false);
  await act(async () => { await ask.open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(requests.map(request => request.operationId)).toEqual([operationId, operationId]);
  expect(ask.entryFor(source, ownerId(source))).toMatchObject({ attached: true, record: { id: operationId, target: { nativeSessionId: 'owner-X' } } });
});

it.each(['create', 'attach'] as const)('retains a submitted question before same-workspace transport retirement during %s can acknowledge success', async phase => {
  const f = await setup();
  const finish = phase === 'create' ? f.pauseCreate() : f.pauseAttach();
  let opening!: Promise<unknown>;
  let submittingDraft = 'submitted question';
  await act(async () => {
    opening = f.current().open(state, source, submittingDraft, phase === 'create', { associationOwner: ownerId(source) }).then(() => { submittingDraft = ''; });
  });
  const original = f.current().entryFor(source, ownerId(source));
  const operationId = (original.pending ?? original.record)!.id;
  const saved = original.inputs?.[0];
  await act(async () => f.replaceTransport());
  await act(async () => { finish(); await opening; });
  expect(submittingDraft).toBe('');
  const question = f.current().entryFor(source, ownerId(source)).inputs?.[0];
  expect(question).toMatchObject({ id: expect.any(String), text: 'submitted question' });
  expect(question?.id).toBe(saved?.id);
  const requestsBeforeRetry = f.requests.length;
  await act(async () => {});
  expect(f.requests).toHaveLength(requestsBeforeRetry);
  await act(async () => { await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(f.current().entryFor(source, ownerId(source)).record?.id).toBe(operationId);
  if (phase === 'create') expect(f.requests.at(-1)?.body.operationId).toBe(operationId);
  else expect(f.requests.at(-1)?.body.nativeSessionId).toBe('ask-native');
  const participant = JSON.stringify([operationId, sessionKey(f.current().entryFor(source, ownerId(source)).record!.target!)]);
  const handoffs: unknown[][] = [];
  await act(async () => {
    f.current().sendInput(sessionKey(source), question!.id, async (...args) => { handoffs.push(args); }, participant);
    f.current().sendInput(sessionKey(source), question!.id, async (...args) => { handoffs.push(args); }, participant);
  });
  expect(handoffs).toEqual([['submitted question', question!.id]]);
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([]);
});

it('blocks cancelled X question handoff after relation refresh and explicit attachment to Y', async () => {
  const f = await setup();
  await act(async () => {
    f.current().close(source, ownerId(source));
    f.current().store.setSharedRelations([{ id: 'queue-relation', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
      target: { ...source, agentId: 'X-agent', nativeSessionId: 'X' } }]);
    await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) });
  });
  const finish = f.pauseAttach();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, 'question for X', false, { associationOwner: ownerId(source) }); });
  await act(async () => f.current().close(source, ownerId(source)));
  await act(async () => { finish(); await opening; });
  const question = f.current().entryFor(source, ownerId(source)).inputs![0]!;
  await act(async () => f.current().store.setSharedRelations([{ id: 'queue-relation', kind: 'ask', createdAt: '2099-01-01T00:00:00.000Z', source,
    target: { ...source, agentId: 'Y-agent', nativeSessionId: 'Y' }, revision: 1 }]));
  const requestsBeforeRetry = f.requests.length;
  expect(f.current().entryFor(source, ownerId(source)).record?.target?.nativeSessionId).toBe('Y');
  await act(async () => { await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  expect(f.requests).toHaveLength(requestsBeforeRetry + 1);
  expect(f.requests.at(-1)?.body.nativeSessionId).toBe('Y');
  const entry = f.current().entryFor(source, ownerId(source));
  const participant = JSON.stringify([entry.record!.id, sessionKey(entry.record!.target!)]);
  const handoffs: unknown[][] = [];
  await act(async () => { f.current().sendInput(sessionKey(source), question.id, async (...args) => { handoffs.push(args); }, participant); });
  expect(handoffs).toEqual([]);
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
  expect(f.current().entryFor(source, ownerId(source)).error).toMatch(/original|owner|different|recipient/i);
  await f.reload();
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
});


it('retains an unowned legacy question after reload and blocks its handoff to a confirmed Ask', async () => {
  const f = await setup();
  const legacy = { id: 'legacy-question', text: 'Keep this legacy question' };
  conversationSessionStorage.setItem(`agent-remote-ask:${baseUrl}:inputs:${sessionKey(source)}`, JSON.stringify([legacy]));
  await f.reload();
  await act(async () => { await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  const entry = f.current().entryFor(source, ownerId(source));
  const handoffs: string[] = [];
  await act(async () => f.current().sendInput(sessionKey(source), legacy.id, async text => { handoffs.push(text); }, JSON.stringify([entry.record!.id, sessionKey(entry.record!.target!)])));
  expect(handoffs).toEqual([]);
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([legacy]);
  expect(f.current().entryFor(source, ownerId(source)).error).toMatch(/original|owner|recipient/i);
});

it('rejects an unsaved submitted question cancelled while its relation query is pending', async () => {
  const f = await setup();
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  let draft = 'Keep the submitting draft';
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, draft, false, { ...{ synchronize: () => held }, associationOwner: ownerId(source) }).then(() => { draft = ''; }, error => error); });
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([]);
  await act(async () => { f.replaceTransport(); });
  await act(async () => { finish(); await opening; });
  expect(draft).toBe('Keep the submitting draft');
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

it('discards only the selected saved question and does not resurrect it when its held preparation completes', async () => {
  const f = await setup();
  const finish = f.pauseAttach();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(undefined, source, 'Discard this held question', false, { associationOwner: ownerId(source) }); });
  const discarded = f.current().entryFor(source, ownerId(source)).inputs![0]!;
  const retained = { id: 'another-question', text: 'Keep another question' };
  f.current().entryFor(source, ownerId(source)).inputs!.push(retained);
  const key = sessionKey(source);
  const outboxKey = 'agent-remote:recovery:concrete-ask-outbox';
  conversationSessionStorage.setItem(outboxKey, 'native-outbox');
  await act(async () => { f.current().discardInput(key, discarded.id); });
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([retained]);
  expect(f.current().drafts.get(key)).toBe('Unsent Ask draft');
  expect(conversationSessionStorage.getItem(outboxKey)).toBe('native-outbox');
  await act(async () => { finish(); await opening; });
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([retained]);
  await f.reload();
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([retained]);
});

it('retains the selected saved question when persisting its discard fails', async () => {
  const f = await setup();
  await act(async () => { await f.current().open(undefined, source, 'Keep this saved question', false, { associationOwner: ownerId(source) }); });
  const question = f.current().entryFor(source, ownerId(source)).inputs![0]!;
  const key = sessionKey(source);
  const remove = vi.spyOn(conversationSessionStorage, 'removeItem').mockImplementation(name => {
    if (name === `agent-remote-ask:${baseUrl}:inputs:${key}`) throw new Error('Storage denied');
  });
  try {
    await act(async () => { f.current().discardInput(key, question.id); });
    expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
    expect(f.current().entryFor(source, ownerId(source)).error).toMatch(/storage|discard|save/i);
  } finally { remove.mockRestore(); }
  await f.reload();
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
});


it('preserves the submitting draft and starts no native request when saving its question fails', async () => {
  const f = await setup();
  let draft = 'Keep this unsaved question';
  const original = conversationSessionStorage.setItem.bind(conversationSessionStorage);
  const save = vi.spyOn(conversationSessionStorage, 'setItem');
  save.mockImplementation((key, value) => {
    if (key === `agent-remote-ask:${baseUrl}:inputs:${sessionKey(source)}`) throw new Error('Question storage denied');
    return original(key, value);
  });
  try {
    await act(async () => {
      await f.current().open(undefined, source, draft, false, { associationOwner: ownerId(source) }).then(() => { draft = ''; }, () => {});
    });
    expect(draft).toBe('Keep this unsaved question');
    expect(f.requests).toHaveLength(1);
    expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([]);
  } finally { save.mockRestore(); }
});

it('does not assign an original no-target question to a reused operation with changed creation evidence', async () => {
  const f = await setup();
  const finish = f.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(state, source, 'Original creation question', true, { associationOwner: ownerId(source) }); });
  const operation = f.current().entryFor(source, ownerId(source)).pending!;
  const key = sessionKey(source);
  await act(async () => f.replaceTransport());
  await act(async () => { finish(); await opening; });
  const question = f.current().entryFor(source, ownerId(source)).inputs![0]!;
  conversationSessionStorage.setItem(`agent-remote-forks:ask:${baseUrl}:record:${operation.id}`,
    JSON.stringify({ ...operation, options: { ...operation.options, model: 'another-creation-model' } }));
  await act(async () => { await f.current().open(undefined, source, '', false, { associationOwner: ownerId(source) }); });
  const handoffs: string[] = [];
  await act(async () => f.current().sendInput(key, question.id, async text => { handoffs.push(text); }));
  expect(handoffs).toEqual([]);
  expect(f.current().entryFor(source, ownerId(source)).inputs).toEqual([question]);
  expect(f.current().entryFor(source, ownerId(source)).error).toMatch(/original|owner|recipient/i);
});

it('does not recreate a saved question or bind native state after workspace unmount and deliberate storage removal', async () => {
  const f = await setup();
  const finish = f.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = f.current().open(state, source, 'Retired workspace question', true, { associationOwner: ownerId(source) }); });
  const operation = f.current().entryFor(source, ownerId(source)).pending!;
  const key = `agent-remote-ask:${baseUrl}:inputs:${sessionKey(source)}`;
  await f.reload();
  conversationSessionStorage.removeItem(key);
  await act(async () => { finish(); await opening; });
  expect(conversationSessionStorage.getItem(key)).toBeNull();
  expect(f.current().store.getLocal(operation.id)?.target).toBeUndefined();
});
it('keeps the explicit Ask owner and its stores after source projection', async () => {
  const fixture = await setup(); const ask = fixture.current(); const key = sessionKey(source);
  const owner = fixtureOwner(source);
  const requests = fixture.requests.length;

  const next = { ...source, nativeSessionId: 'B', agentId: 'runtime-B' };
  await act(async () => { expect(ask.applySourceProjection(owner.id, next, ask.ownerEditRevision(owner.id), () => true).status).toBe('applied'); });
  expect(fixture.requests).toHaveLength(requests);
  expect(ask.entryFor(next, owner.id)).toMatchObject({ source: next, attached: true, record: { source, target: { nativeSessionId: 'ask-native' } } });
  expect(ask.isOpen(next, owner.id)).toBe(true);
  expect(ask.draftBinding(owner.id).store.get(key)).toBe('Unsent Ask draft');
  await act(async () => ask.close(next, owner.id));
  expect(ask.isOpen(next, owner.id)).toBe(false);
  await fixture.reload(); const restored = fixture.current();
  expect(fixtureDocument().asks).toMatchObject([owner]);
  expect(fixtureDocument().asks[0]!.records).toEqual([{ id: ask.entryFor(next, owner.id).record!.id, target: sessionKey(ask.entryFor(next, owner.id).record!.target!) }]);
  expect(restored.entryFor(next, owner.id).record?.target?.nativeSessionId).toBe('ask-native');
  expect(restored.draftBinding(owner.id).store.get(key)).toBe('Unsent Ask draft');
});

it('retains an original pending creation while retiring its window callbacks', async () => {
  const fixture = await setup(); const finish = fixture.pauseCreate();
  let opening!: Promise<unknown>;
  await act(async () => { opening = fixture.current().open(state, source, 'saved question', true, { associationOwner: ownerId(source) }); });
  const original = fixture.current().entryFor(source, ownerId(source)).pending!; const key = sessionKey(source);
  const owner = fixtureOwner(source);

  const next = { ...source, nativeSessionId: 'B', agentId: 'runtime-B' };
  await act(async () => { const ask = fixture.current(); ask.applySourceProjection(owner.id, next, ask.ownerEditRevision(owner.id), () => true); finish(); await opening; });
  expect(fixture.current().store.getLocal(original.id)?.target?.nativeSessionId).toBe('ask-native');
  expect(fixture.current().entryFor(next, owner.id)).toMatchObject({ source: next, inputs: [{ text: 'saved question' }] });
  expect(fixture.current().entryFor(next, owner.id).record?.id).not.toBe(original.id);
  expect(fixture.current().store.getLocal(original.id)?.creationKey).toBe(original.creationKey);
  expect(fixture.requests.filter(request => request.path.endsWith('/create'))).toHaveLength(2);
});

it('recovers unread questions before retaining a closed no-record owner and never replaces them with empty UI state', async () => {
  const fixture = await setup(); const ask = fixture.current();
  const closed = { ...source, nativeSessionId: 'no-record', agentId: 'closed-runtime' }, key = sessionKey(closed);
  const inputsKey = `agent-remote-ask:${baseUrl}:inputs:${key}`;
  const originalQuestions = [{ id: 'original', text: 'Preserve the unanswered question' }];
  conversationSessionStorage.setItem(inputsKey, JSON.stringify(originalQuestions));
  const originalRead = conversationSessionStorage.getItem.bind(conversationSessionStorage);
  const denied = vi.spyOn(conversationSessionStorage, 'getItem').mockImplementation(value => { if (value === inputsKey) throw new Error('Unavailable'); return originalRead(value); });
  expect(ask.entryFor(closed, ownerId(closed)).inputs).toEqual([]);
  const owner = fixtureOwner(closed);

  denied.mockRestore();
  const requestCount = fixture.requests.length;
  await act(async () => { expect((await ask.retainAssociationOwners([owner.id], () => true)).status).toBe('pending'); });
  expect(ask.entryFor(closed, owner.id).inputs).toEqual(originalQuestions);
  expect(JSON.parse(conversationSessionStorage.getItem(inputsKey)!)).toEqual(originalQuestions);
  await act(async () => { expect((await ask.retainAssociationOwners([owner.id], () => true)).status).toBe('applied'); });
  expect(ask.isOpen(closed, owner.id)).toBe(false);
  expect(fixtureDocument().asks.find(value => value.id === owner.id)?.records ?? []).toEqual([]);
  expect(fixture.requests).toHaveLength(requestCount);
});

it('rechecks earlier owner text edits while retaining a later closed owner', async () => {
  const fixture = await setup(), ask = fixture.current();
  const sources = [source, { ...source, nativeSessionId: 'closed-two', agentId: 'closed-two' }];
  const owners = sources.map(fixtureOwner);
  const first = ask.draftBinding(owners[0]!.id), second = ask.draftBinding(owners[1]!.id);
  let finish!: () => void, entered = false; const held = new Promise<void>(resolve => { finish = resolve; });
  const flush = second.store.flushCurrent.bind(second.store);
  const pause = vi.spyOn(second.store, 'flushCurrent').mockImplementation(async (key, revision, current) => {
    const result = await flush(key, revision, current);
    if (key === second.key) { entered = true; await held; }
    return result;
  });
  let retention!: ReturnType<typeof ask.retainAssociationOwners>;
  await act(async () => { retention = ask.retainAssociationOwners(owners.map(owner => owner.id), () => true); });
  expect(entered).toBe(true);
  await act(async () => { first.store.set(first.key, 'New bound-composer edit'); finish(); expect((await retention).status).toBe('pending'); });
  pause.mockRestore();
  await act(async () => { expect((await ask.retainAssociationOwners(owners.map(owner => owner.id), () => true)).status).toBe('applied'); });
  expect(first.store.get(first.key)).toBe('New bound-composer edit');
});

it('retains an Ask-on-Side owner independently when only the primary source is projected', async () => {
  const fixture = await setup();
  const side = { ...source, nativeSessionId: 'independent-side', agentId: 'side-runtime' };
  await act(async () => { await fixture.current().open(state, side, '', false, { associationOwner: ownerId(side) }); });
  const ask = fixture.current();
  const owners = [source, side].map(fixtureOwner);
  await act(async () => ask.close(side, owners[1]!.id));
  const original = ask.entryFor(side, owners[1]!.id), record = original.record!, requestCount = fixture.requests.length;
  const next = { ...source, nativeSessionId: 'B', agentId: 'B' };
  await act(async () => {
    expect((await ask.retainAssociationOwners(owners.map(owner => owner.id), () => true)).status).toBe('applied');
    expect(ask.applySourceProjection(owners[0]!.id, next, ask.ownerEditRevision(owners[0]!.id), () => true).status).toBe('applied');
  });
  expect(ask.entryFor(side, owners[1]!.id)).toMatchObject({ source: side, record });
  expect(ask.store.getLocal(record.id)?.source).toEqual(side);
  expect(ask.isOpen(side, owners[1]!.id)).toBe(false); expect(fixture.requests).toHaveLength(requestCount);
});

it('retries failed composition retention without losing the window or starting native work', async () => {
  const fixture = await setup(), ask = fixture.current(), owner = fixtureOwner(source);
  const originalWrite = conversationSessionStorage.setItem.bind(conversationSessionStorage);
  const denied = vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(':composition-v2')) throw new Error('Full'); originalWrite(key, value);
  });
  await act(async () => { expect((await ask.retainAssociationOwners([owner.id], () => true)).status).toBe('failed'); });
  expect(ask.isOpen(source, owner.id)).toBe(true);
  const requests = fixture.requests.length;
  denied.mockRestore();
  await act(async () => { expect((await ask.retainAssociationOwners([owner.id], () => true)).status).toBe('applied'); });
  expect(ask.isOpen(source, owner.id)).toBe(true);
  expect(ask.entryFor(source, owner.id).record?.target?.nativeSessionId).toBe('ask-native');
  expect(fixture.requests).toHaveLength(requests);
});

it('routes discovered Ask relations to explicit role and fixed owners of the same native session', async () => {
  const document = fixtureDocument();
  const origin = { controllerId: 'installation', providerId: source.providerId, nativeSessionId: source.nativeSessionId };
  const role = createCompositionSlot('role-view', source, baseUrl);
  role.intent = { kind: 'role', roleKey: compositionRoleKey({ scope: baseUrl, hostId: 'local', controllerId: 'installation', roleId: 'primary' }),
    revision: 2, target: { hostId: 'local', native: origin } };
  const fixed = createCompositionSlot('fixed-view', source, baseUrl);
  fixed.intent.target.native.controllerId = origin.controllerId;
  const history = createCompositionSlot('history-view', source, baseUrl);
  history.intent = { kind: 'history', target: fixed.intent.target };
  document.slots.push(role, fixed, history);
  const owners = [role, fixed, history].map(slot => createAskOwner(slot, baseUrl));
  document.asks.push(...owners); document.editRevision++;
  let ask!: ReturnType<typeof useAskConversations>;
  function Harness() { ask = useAskConversations(document, {} as import('@orchardworks/agent-remote-web').RemoteAgentTransport); return null; }
  await render(<Harness />);
  const relations: import('@orchardworks/agent-remote-hosted/session-relations').SessionRelation[] = [
    { id: 'role-ask', kind: 'ask', createdAt: '2026-10-11T00:00:00.000Z', source, target: { ...source, nativeSessionId: 'role-ask', agentId: 'role-agent' },
      sourceBinding: { kind: 'primary_role', roleId: 'primary', origin }, hostLocator: { hostId: 'local', controllerId: 'installation' } },
    { id: 'fixed-ask', kind: 'ask', createdAt: '2026-10-11T00:00:00.000Z', source, target: { ...source, nativeSessionId: 'fixed-ask', agentId: 'fixed-agent' },
      sourceBinding: { kind: 'fixed', source: origin }, hostLocator: { hostId: 'local', controllerId: 'installation' } },
    { id: 'foreign-ask', kind: 'ask', createdAt: '2026-10-11T00:00:00.000Z', source, target: { ...source, nativeSessionId: 'foreign-ask', agentId: 'foreign-agent' },
      sourceBinding: { kind: 'primary_role', roleId: 'primary', origin: { ...origin, controllerId: 'other' } }, hostLocator: { hostId: 'local', controllerId: 'other' } },
  ];
  await act(async () => ask.store.setSharedRelations(relations));
  expect(ask.entryFor(source, owners[0]!.id).record?.target?.nativeSessionId).toBe('role-ask');
  expect(ask.entryFor(source, owners[1]!.id).record?.target?.nativeSessionId).toBe('fixed-ask');
  expect(ask.entryFor(source, owners[2]!.id).record).toBeUndefined();
  const references = structuredClone(document.asks.map(owner => owner.records));
  await act(async () => ask.store.setSharedRelations(relations));
  expect(document.asks.map(owner => owner.records)).toEqual(references);
  expect(document.asks.every(owner => !owner.open)).toBe(true);
});
