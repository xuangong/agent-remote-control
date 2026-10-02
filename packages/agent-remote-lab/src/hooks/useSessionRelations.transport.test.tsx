import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import { render } from '../test/setup.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { useSessionRelations } from './useSessionRelations.js';

const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const side: SessionRelation = { id: 'side', kind: 'side', createdAt: '2026-10-02T00:00:00.000Z', source,
  target: { ...source, nativeSessionId: 'side', agentId: 'side-agent', title: 'Side' } };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  localStorage.clear();
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void): Promise<string> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => { response.writeHead(500).end(); }); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}/u/alice/`;
}
function reply(response: ServerResponse, relations: SessionRelation[], status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ relations }));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}
async function mount(baseUrl: string, sides = new ForkStore(baseUrl), enabled = true, accountScoped = enabled) {
  let relations!: ReturnType<typeof useSessionRelations>;
  const asks = new ForkStore(baseUrl + 'ask');
  function Harness() { relations = useSessionRelations(baseUrl, enabled, sides, asks, 'main', accountScoped); return null; }
  await render(<Harness />);
  await act(async () => relations());
  return { sides, asks, relations };
}

it('changes only shared navigation through a versioned PATCH and preserves the local first-input ledger', async () => {
  const sides = new ForkStore('shared-unlink-wire');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target); sides.markConfigured(record.id);
  await sides.send(record.id, 'first question', async () => {}, async () => false);
  let shared: SessionRelation[] = [side];
  const patches: Record<string, unknown>[] = [];
  const baseUrl = await serve(async (request, response) => {
    if (request.method === 'PATCH') {
      patches.push(await body(request));
      shared = [{ ...side, linked: false, revision: 1 }];
    }
    reply(response, shared);
  });
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(patches).toEqual([{ hostId: 'host', providerId: 'codex', nativeSessionId: 'side', sourceNativeSessionId: 'main', id: 'side', linked: false, expectedRevision: 0 }]);
  expect(sides.linked()).toEqual([]);
  expect(sides.get(record.id)).toMatchObject({ linked: false, revision: 1, delivery: 'sent', firstInput: 'first question' });
});

it('ignores a GET started before an acknowledged PATCH even when that GET omits the relation', async () => {
  let held: ServerResponse | undefined;
  let holdNext = false;
  let getStarted!: () => void;
  const started = new Promise<void>((resolve) => { getStarted = resolve; });
  let shared: SessionRelation[] = [side];
  const baseUrl = await serve((request, response) => {
    if (request.method === 'GET' && holdNext) { holdNext = false; held = response; getStarted(); return; }
    if (request.method === 'PATCH') shared = [{ ...side, linked: false, revision: 1 }];
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  holdNext = true;
  const staleRefresh = relations();
  void staleRefresh.catch(() => {});
  await started;
  await act(async () => relations.setLinked(sides.get('side'), false));
  reply(held!, []);
  await act(async () => staleRefresh);
  expect(sides.all()).toHaveLength(1);
  expect(sides.get('side')).toMatchObject({ linked: false, revision: 1 });
  expect(sides.linked()).toEqual([]);
});

it('keeps a shared tombstone authoritative instead of reimporting an older browser ledger', async () => {
  const sides = new ForkStore('old-ledger-tombstone');
  const local = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(local.id, side.target); sides.markConfigured(local.id);
  const methods: string[] = [];
  const baseUrl = await serve((request, response) => {
    methods.push(request.method!);
    reply(response, [{ ...side, linked: false, revision: 2 }]);
  });
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations());
  expect(methods).not.toContain('POST');
  expect(sides.get(local.id)).toMatchObject({ linked: false, revision: 2, delivery: 'pending' });
  expect(sides.linked()).toEqual([]);
});

it('rejects a stale Undo and exposes the newer shared revision for an explicit retry', async () => {
  let shared: SessionRelation[] = [{ ...side, linked: false, revision: 1 }];
  const baseUrl = await serve(async (request, response) => {
    if (request.method === 'PATCH') {
      const input = await body(request);
      if (input.expectedRevision !== shared[0]!.revision) {
        response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relation_conflict', message: 'Changed' } }));
        return;
      }
      shared = [{ ...side, linked: input.linked as boolean, revision: shared[0]!.revision! + 1 }];
    }
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  const undo = sides.get('side');
  shared = [{ ...side, linked: false, revision: 3 }];
  await expect(relations.setLinked(undo, true)).rejects.toThrow(/changed/);
  expect(sides.get('side')).toMatchObject({ linked: false, revision: 3 });
  await act(async () => relations.setLinked(sides.get('side'), true));
  expect(sides.linked()).toHaveLength(1);
  expect(sides.get('side').revision).toBe(4);
});

it('reports a lost PATCH receipt as unconfirmed and lets a refresh discover the committed state', async () => {
  let shared: SessionRelation[] = [side];
  const baseUrl = await serve((request, response) => {
    if (request.method === 'PATCH') {
      shared = [{ ...side, linked: false, revision: 1 }];
      response.destroy();
      return;
    }
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow(/confirm/);
  await act(async () => relations());
  expect(sides.linked()).toEqual([]);
  expect(sides.get('side').revision).toBe(1);
});

it('persists local-mode unlink without a server and keeps Ask read-only for this operation', async () => {
  const sides = new ForkStore('local-relations');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target);
  const { asks, relations } = await mount('http://localhost/', sides, false);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(new ForkStore('local-relations').get(record.id)).toMatchObject({ linked: false, revision: 1 });
  asks.setSharedRelations([{ ...side, id: 'ask', kind: 'ask', target: { ...side.target, nativeSessionId: 'ask' } }]);
  await expect(relations.setLinked(asks.get('ask'), false)).rejects.toThrow(/side/i);
});

it('does not treat a hosted workspace restoring access as local-mode success', async () => {
  const sides = new ForkStore('restoring-hosted');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target);
  const { relations } = await mount('http://localhost/', sides, false, true);
  await expect(relations.setLinked(sides.get(record.id), false)).rejects.toThrow(/access is restoring/);
  expect(sides.linked()).toHaveLength(1);
  expect(sides.get(record.id).revision).toBeUndefined();
});

it('does not report a successful unlink when a PATCH response has no authoritative tombstone', async () => {
  const baseUrl = await serve((_request, response) => reply(response, [side]));
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow(/confirm/);
  expect(sides.linked()).toHaveLength(1);
});

it.each([
  { code: 'forbidden', error: 'Workspace permission is required.' },
  { error: { code: 'forbidden', message: 'Workspace permission is required.' } },
])('reports an explicit permission refusal separately from an unknown transport outcome: %j', async (error) => {
  const baseUrl = await serve((request, response) => {
    if (request.method === 'PATCH') {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify(error));
      return;
    }
    reply(response, [side]);
  });
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow('Workspace permission is required.');
  expect(sides.linked()).toHaveLength(1);
});

it('keeps hosted snapshot forks local because they have no shared reference relation', async () => {
  const methods: string[] = [];
  const baseUrl = await serve((request, response) => { methods.push(request.method!); reply(response, []); });
  const sides = new ForkStore(baseUrl);
  const record = sides.prepare({ source, capturedAt: '2026-10-02T00:00:00.000Z', boundary: { epoch: 'one', seq: 2 }, itemCount: 0, text: '[]' });
  sides.bind(record.id, side.target);
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(new ForkStore(baseUrl).linked()).toEqual([]);
  expect(methods).not.toContain('PATCH');
});
