import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { render, unmount } from '../test/setup.js';
import { currentForkSource } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import { useAskConversations } from './useAskConversations.js';

const servers: Server[] = [];
const current = { hostId: 'selected-host', providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
const target = { hostId: 'ask-host', providerId: 'codex', nativeSessionId: 'X', agentId: 'old-X-agent', title: 'Retained Ask',
  parentNativeSessionId: 'A', parentAgentId: 'old-A-agent', createdAt: '2026-10-10T00:00:00.000Z' };
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  conversationLocalStorage.clear(); conversationSessionStorage.clear(); localStorage.clear(); sessionStorage.clear();
});
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}
async function fixture(savedTarget: OpenedSession = target, source = current) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let responseId: string | undefined = savedTarget.nativeSessionId;
  let error: string | undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void body(request).then(input => {
      requests.push({ path: request.url!, body: input });
      response.writeHead(error ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(error
        ? { error } : { agentId: 'confirmed-X-agent', ...(responseId === undefined ? {} : { nativeSessionId: responseId }) }));
    }).catch(() => response.writeHead(500).end());
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const directory = new SessionDirectoryClient(baseUrl, undefined, 'selected-host');
  const transport = {} as never;
  let ask!: ReturnType<typeof useAskConversations>;
  function Harness() { ask = useAskConversations(baseUrl, transport, directory, 'selected-host'); return null; }
  let container = await render(<Harness />);
  const relation: SessionRelation = { id: 'retained-ask', kind: 'ask', createdAt: target.createdAt, source, target: savedTarget as SessionRelation['target'],
    hostLocator: { hostId: savedTarget.hostId ?? 'local', controllerId: 'ask-installation' },
    nativeSourceRef: { controllerId: 'ask-installation', providerId: 'codex', nativeSessionId: 'A' } };
  await act(async () => { ask.store.setSharedRelations([relation]); ask.setDraft(sessionKey(source), 'Retained question'); });
  return { current: () => ask, requests, source, relation,
    responseId: (id?: string) => { responseId = id; }, fail: (message?: string) => { error = message; },
    reload: async () => { await unmount(container); container = await render(<Harness />); await act(async () => ask.store.setSharedRelations([relation])); } };
}

it('attaches a projected Ask using its own full Host/provider/native locator and preserves metadata on reload', async () => {
  const f = await fixture();
  const record = f.current().entryFor(current).record!;
  expect(f.requests).toEqual([]);
  await act(async () => { await f.current().open(undefined, current); });
  expect(f.requests).toEqual([{ path: '/v1/remote/hosts/ask-host/attach', body: { providerId: 'codex', nativeSessionId: 'X' } }]);
  expect(f.current().entryFor(current)).toMatchObject({ attached: true, record: { id: record.id, target: { ...target, agentId: 'confirmed-X-agent' } } });
  expect(f.current().store.allLocal()).toEqual([]);
  await act(async () => f.current().store.setSharedRelations([{ ...f.relation, revision: 1, target: { ...target, agentId: 'refreshed-X-agent' } }]));
  expect(f.current().entryFor(current).record?.id).toBe(record.id);
  expect(f.requests).toHaveLength(1);
  await f.reload();
  expect(f.requests).toHaveLength(1);
  await act(async () => { await f.current().open(undefined, current); });
  expect(f.requests.at(-1)).toEqual(f.requests[0]);
  expect(f.current().drafts.get(sessionKey(current))).toBe('Retained question');
});

it('preserves requested X when attach omits the native result and rejects an explicit different native result', async () => {
  const f = await fixture();
  f.responseId();
  await act(async () => { await f.current().open(undefined, current); });
  expect(f.current().entryFor(current)).toMatchObject({ attached: true, record: { target: { ...target, agentId: 'confirmed-X-agent' } } });
  f.responseId('wrong-native');
  await act(async () => { await expect(f.current().open(undefined, current)).rejects.toThrow(/different|changed|match/i); });
  expect(f.current().entryFor(current)).toMatchObject({ attached: false, busy: false, record: { target: { ...target, agentId: 'confirmed-X-agent' } } });
  expect(f.current().drafts.get(sessionKey(current))).toBe('Retained question');
  f.responseId('X');
  await act(async () => { await f.current().open(undefined, current); });
  expect(f.requests).toHaveLength(3);
  expect(f.requests.every(request => request.path === '/v1/remote/hosts/ask-host/attach' && request.body.providerId === 'codex' && request.body.nativeSessionId === 'X')).toBe(true);
});

it.each([
  { saved: { ...target, hostId: undefined }, path: '/v1/remote/attach' },
  { saved: { ...target, hostId: 'other-host', providerId: 'claude' }, path: '/v1/remote/hosts/other-host/attach' },
])('normalizes omitted local Host and keeps identical native IDs distinct: $path', async ({ saved, path }) => {
  const f = await fixture(saved);
  await act(async () => { await f.current().open(undefined, current); });
  expect(f.requests).toEqual([{ path, body: { providerId: saved.providerId, nativeSessionId: 'X' } }]);
  expect(f.current().entryFor(current).record?.target).toEqual({ ...saved, agentId: 'confirmed-X-agent' });
});

it.each(['providerId', 'nativeSessionId'] as const)('rejects an incomplete saved %s without substituting the current source or running HTTP', async field => {
  const f = await fixture({ ...target, [field]: '' });
  await act(async () => { await expect(f.current().open(undefined, current)).rejects.toThrow(/identity|locator|unavailable/i); });
  expect(f.requests).toEqual([]);
  expect(f.current().entryFor(current).attached).not.toBe(true);
  expect(f.current().drafts.get(sessionKey(current))).toBe('Retained question');
});

it('keeps nested Ask attached to Side S while only the primary ancestor moves', async () => {
  const side = { ...target, nativeSessionId: 'S', agentId: 'S-agent', title: 'Side S' };
  const f = await fixture(target, side);
  const refreshedSide = { ...side, parentNativeSessionId: 'B' };
  await act(async () => f.current().store.setSharedRelations([{ ...f.relation, source: refreshedSide, revision: 1 }]));
  const entry = f.current().entryFor(side);
  expect(sessionKey(currentForkSource(entry.record!))).toBe(sessionKey(side));
  expect(f.current().entryFor(current).record).toBeUndefined();
  expect(f.requests).toEqual([]);
  await act(async () => { await f.current().open(undefined, side); });
  expect(f.requests).toEqual([{ path: '/v1/remote/hosts/ask-host/attach', body: { providerId: 'codex', nativeSessionId: 'X' } }]);
});

it('routes explicit no-target retry to the checked original Host/provider/options after projected metadata changes', async () => {
  const f = await fixture();
  const original = { ...current, hostId: 'original-host', providerId: 'codex', nativeSessionId: 'A', agentId: 'A-agent' };
  const options = { conversationKind: 'ask' as const, sourceNativeSessionId: 'A', model: 'original-model', cwd: '/original',
    creationSource: { providerId: 'codex', nativeSessionId: 'A' } };
  let pending!: import('../session-forks.js').SessionFork;
  await act(async () => { pending = f.current().store.prepare({ mode: 'reference', source: original, capturedAt: '2026-10-10T00:00:00.000Z' }, options, [], sessionKey(original)); });
  const retained = f.current().entryFor(original);
  retained.pending = { ...pending, source: current, options: { model: 'projected-model' } };
  retained.source = current;
  expect(f.requests).toEqual([]);
  await act(async () => { await f.current().open(undefined, original); });
  expect(f.requests).toEqual([{ path: '/v1/remote/hosts/original-host/create', body: { providerId: 'codex', operationId: pending.id,
    conversationKind: 'ask', sourceNativeSessionId: 'A', model: 'original-model', cwd: '/original', creationSource: { providerId: 'codex', nativeSessionId: 'A' } } }]);
  expect(f.current().store.getLocal(pending.id)).toMatchObject({ source: original, options, settings: [], target: { hostId: 'original-host', providerId: 'codex', nativeSessionId: 'X' } });
  expect(f.current().store.allLocal()).toHaveLength(1);
});

it('retains the existing participant and its source-scoped state when shared navigation source moves again', async () => {
  const f = await fixture();
  await act(async () => { await f.current().open(undefined, current); });
  const confirmed = f.current().entryFor(current).record!;
  const moved = { ...current, nativeSessionId: 'C', agentId: 'C-agent', title: 'Current C' };
  await act(async () => f.current().store.setSharedRelations([{ ...f.relation, source: moved, revision: 1 }]));
  expect(f.current().entryFor(current)).toMatchObject({ attached: true, record: { id: confirmed.id, target: { ...target, agentId: 'confirmed-X-agent' } } });
  expect(currentForkSource(f.current().entryFor(current).record!)).toEqual(moved);
  expect(f.current().isOpen(current)).toBe(true);
  expect(f.current().isEnabled(current)).toBe(true);
  expect(f.current().drafts.get(sessionKey(current))).toBe('Retained question');
  expect(f.current().drafts.get(sessionKey(moved))).toBe('');
  expect(f.requests).toHaveLength(1);
  expect(f.current().entryFor(moved).attached).not.toBe(true);
});
