import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProviderAdapter, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { afterEach, expect, it } from 'vitest';

import { createAgentHostRuntime, type AgentHostDirectory, type AgentHostRuntime } from './host.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 20));

interface SessionOptions { history: boolean; live?: ProviderStreamItem[]; reads?: { count: number }; changed?: boolean }

function session(options: SessionOptions): AgentSession {
  let disposed: () => void = () => undefined;
  const ended = new Promise<void>(resolve => { disposed = resolve; });
  return {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() {
      if (options.history) {
        yield { type: 'observation' as const, sourceKey: 'history:1', occurredAt: 1_725_000_000_000, delivery: 'history' as const, itemIdentity: { key: 'm1', completes: true },
          event: { type: 'timeline' as const, provider: 'codex', item: { type: 'assistant_message' as const, text: 'See [shot](shot.png).', messageId: 'm1' } } };
      }
      yield { type: 'history_boundary' as const };
      for (const item of options.live ?? []) yield item;
      await ended;
    },
    async sendMessage() {}, async respondToInteraction() {},
    async readResource() {
      if (options.reads) options.reads.count += 1;
      return { status: 'available' as const, mediaType: 'image/png', bytes: options.changed ? Uint8Array.from([...png.slice(0, -1), 0]) : png };
    },
    async runtimeInfo() { return { providerId: 'codex', sessionId: 'native', status: 'idle' as const, persistence: { providerId: 'codex', sessionId: 'native', opaque: '{}' } }; },
    async dispose() { disposed(); },
  };
}

function runtime(options: SessionOptions, extra: Parameters<typeof createAgentHostRuntime>[0] extends infer T ? Partial<T> : never = {}, journal = false): AgentHostRuntime {
  const directory: AgentHostDirectory = { providerId: 'codex', list: async () => [], workspaces: async () => [], async create() { return 'native'; }, async open() { return session(options); }, async close() {} };
  const adapter: AgentProviderAdapter = { descriptor: { providerId: 'codex', displayName: 'Codex' }, ...(journal ? { journal: { itemIdentity: 1 as const } } : {}),
    async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); } };
  return createAgentHostRuntime({ registrations: [{ adapter, directory }], ...extra });
}

async function attach(host: AgentHostRuntime) {
  const attached = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native' }) });
  expect(attached.status).toBe(200);
  await flush();
  return host.resolveSession('agent-1')!;
}

const imageOf = (manager: Awaited<ReturnType<typeof attach>>) =>
  manager.fetchTimeline({ requestId: 'h', agentId: 'agent-1', direction: 'tail', limit: 10 }).payload.entries[0]?.resources?.[0]?.resourceId;

async function files() {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-ids-'));
  roots.push(root);
  return { resourceIdKeyFile: join(root, 'resource-id.key'), resourceIdIndexFile: join(root, 'resource-id-index.json') };
}

it('gives the image of a session the same id after the Controller restarts, when it keeps its resource key', async () => {
  const keep = await files();
  const first = runtime({ history: true }, keep);
  let before: string | undefined;
  try { before = imageOf(await attach(first)); } finally { await first.close(); }
  expect(before).toMatch(/^rid_/);
  const second = runtime({ history: true }, keep);
  try { expect(imageOf(await attach(second))).toBe(before); } finally { await second.close(); }
  const unkeyed = runtime({ history: true });
  try {
    const id = imageOf(await attach(unkeyed));
    expect(id).toBeDefined();
    expect(id).not.toMatch(/^rid_/);
  } finally { await unkeyed.close(); }
});

it('serves an image id from before the restart without any timeline reading it again', async () => {
  const keep = await files();
  const first = runtime({ history: true }, keep);
  let before: string | undefined;
  try { before = imageOf(await attach(first)); } finally { await first.close(); }
  expect(JSON.parse(await readFile(keep.resourceIdIndexFile, 'utf8')).entries).toMatchObject([{ agentId: 'agent-1', resourceId: before, readLocator: 'shot.png' }]);
  if (process.platform !== 'win32') expect((await stat(keep.resourceIdIndexFile)).mode & 0o777).toBe(0o600);

  // The session's history no longer holds the image, so only a read of its id can bring the bytes back.
  const reads = { count: 0 };
  const second = runtime({ history: false, reads }, keep);
  try {
    const manager = await attach(second);
    expect(reads.count).toBe(0);
    expect((await manager.readResource('a', before!)).payload.state.status).toBe('pending');
    await flush();
    expect(reads.count).toBe(1);
    expect((await manager.readResource('b', before!)).payload.state).toMatchObject({ status: 'available', mediaType: 'image/png', byteLength: png.byteLength });
  } finally { await second.close(); }
});

it('does not serve an old id when the file now holds other bytes, and does not for another session', async () => {
  const keep = await files();
  const first = runtime({ history: true }, keep);
  let before: string | undefined;
  try { before = imageOf(await attach(first)); } finally { await first.close(); }
  const second = runtime({ history: false, changed: true }, keep);
  try {
    const manager = await attach(second);
    await manager.readResource('a', before!);
    await flush();
    expect((await manager.readResource('b', before!)).payload.state).toMatchObject({ status: 'unavailable', reason: 'Resource content changed.' });
  } finally { await second.close(); }
});

it('tells the Controller\'s own journal tap when a journal-capable provider omits item identity', async () => {
  const live = [{ type: 'observation' as const, sourceKey: 'stream:2', occurredAt: 1_725_000_000_001, delivery: 'live' as const,
    event: { type: 'timeline' as const, provider: 'codex', item: { type: 'assistant_message' as const, text: 'No identity', messageId: 'm2' } } }];
  for (const [journal, expected] of [[true, 1], [false, 0]] as const) {
    const host = runtime({ history: false, live }, {}, journal);
    try {
      const manager = await attach(host);
      let told = 0;
      manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
      await flush();
      expect(told).toBe(expected);
    } finally { await host.close(); }
  }
});

it('carries the journal declaration of a provider registered after start', async () => {
  const live = [{ type: 'observation' as const, sourceKey: 'stream:2', occurredAt: 1_725_000_000_001, delivery: 'live' as const,
    event: { type: 'timeline' as const, provider: 'codex', item: { type: 'assistant_message' as const, text: 'No identity', messageId: 'm2' } } }];
  const other: AgentHostDirectory = { providerId: 'other', list: async () => [], workspaces: async () => [], async create() { return 'x'; }, async open() { throw new Error('unused'); }, async close() {} };
  const host = createAgentHostRuntime({ registrations: [{ adapter: { descriptor: { providerId: 'other', displayName: 'Other' }, async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); } }, directory: other }] });
  try {
    const directory: AgentHostDirectory = { providerId: 'codex', list: async () => [], workspaces: async () => [], async create() { return 'native'; }, async open() { return session({ history: false, live }); }, async close() {} };
    const adapter: AgentProviderAdapter = { descriptor: { providerId: 'codex', displayName: 'Codex' }, journal: { itemIdentity: 1 },
      async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); } };
    host.addRegistration({ adapter, directory });
    const manager = await attach(host);
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    await flush();
    expect(told).toBe(1);
  } finally { await host.close(); }
});
