import { expect, it } from 'vitest';
import { createWindowView, type WindowMutation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createRelayState, createWindowWorkspaces, emptyRelayState, handleWindowRequest } from '@orchardworks/agent-relay-core';
import { WindowWorkspaceClient } from '@orchardworks/agent-client';
import { WindowWorkspaceStore } from './window-workspace.js';

it.each(['empty', 'bound'] as const)('rejects a delayed %s destination after an earlier binding commits in the queue', async mode => {
  const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'window-queue-test-secret-01234567890123456789' };
  const source = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' };
  const replacement = { ...source, nativeSessionId: 'replacement', title: 'Replacement' };
  const created = { ...source, nativeSessionId: 'created', title: 'Created' };
  const initial: WorkspaceWindow = { schemaVersion: 3, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', mode === 'bound' ? source : undefined, 'primary')] };
  const state = createRelayState(auth, { initial: emptyRelayState(auth), async commit() {} }, () => {}, () => {});
  const service = createWindowWorkspaces(state, subject => subject === 'alice');
  const mutations: WindowMutation[] = [];
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? init.body : undefined;
    if (method === 'POST' && url.pathname.endsWith('/operations')) {
      mutations.push(JSON.parse(body!));
      if (mutations.length === 1) { entered(); await held; }
    }
    return handleWindowRequest(service, new Request(`http://fixture${url.pathname}${url.search}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}),
    }), { subject: 'alice' });
  };
  const client = new WindowWorkspaceClient('https://relay.example', fetcher);
  try {
    await client.create(initial);
    const store = new WindowWorkspaceStore(initial, client);
    const expectedBinding = store.getSnapshot().views[0]?.binding ?? null;
    const earlier = store.operate({ type: 'view.bind', viewId: 'main', binding: replacement });
    await pending;
    const delayed = store.operate({ type: 'view.bind', viewId: 'main', binding: created, expectedBinding });
    const rejected = expect(delayed).rejects.toThrow('The target session view changed');
    release(); await earlier; await rejected;
    expect(mutations).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, views: [{ id: 'main', binding: replacement }] });
    expect((await client.inspect(initial.id)).window.views[0]?.binding).toEqual(replacement);
    // A stale command from another page is also rejected by the shared service.
    const stale: WindowMutation = { operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: 1,
      operation: { type: 'view.bind', viewId: 'main', binding: created, expectedBinding } };
    await client.mutate(initial.id, stale);
    const receipt = await client.operation(initial.id, stale.operationId);
    expect(receipt).toMatchObject({ status: 'rejected', code: 'invalid_operation', revision: 1,
      message: 'The target session view changed. Choose it again before opening a session.' });
    const retry = await client.mutate(initial.id, stale);
    expect(retry.result).toEqual(receipt);
    expect(retry.window.views[0]?.binding).toEqual(replacement);
  } finally { release(); service.close(); }
});
