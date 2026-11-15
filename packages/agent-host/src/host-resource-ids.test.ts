import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { afterEach, expect, it } from 'vitest';

import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function session(): AgentSession {
  return {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() {
      yield { type: 'observation' as const, sourceKey: 'history:1', occurredAt: 1_725_000_000_000, delivery: 'history' as const,
        event: { type: 'timeline' as const, provider: 'codex', item: { type: 'assistant_message' as const, text: 'See [shot](shot.png).', messageId: 'm1' } } };
      yield { type: 'history_boundary' as const };
    },
    async sendMessage() {}, async respondToInteraction() {},
    async readResource() { return { status: 'available' as const, mediaType: 'image/png', bytes: png }; },
    async runtimeInfo() { return { providerId: 'codex', sessionId: 'native', status: 'idle' as const, persistence: { providerId: 'codex', sessionId: 'native', opaque: '{}' } }; },
    async dispose() {},
  };
}

async function imageIdAfterStart(resourceIdKeyFile: string | undefined): Promise<string | undefined> {
  const directory: AgentHostDirectory = { providerId: 'codex', list: async () => [], workspaces: async () => [], async create() { return 'native'; }, async open() { return session(); }, async close() {} };
  const adapter = { descriptor: { providerId: 'codex', displayName: 'Codex' }, async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); } };
  const host = createAgentHostRuntime({ registrations: [{ adapter, directory }], ...(resourceIdKeyFile ? { resourceIdKeyFile } : {}) });
  try {
    const attached = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'agent-1', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native' }) });
    expect(attached.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 20));
    const page = host.resolveSession('agent-1')!.fetchTimeline({ requestId: 'h', agentId: 'agent-1', direction: 'tail', limit: 10 });
    return page.payload.entries[0]?.resources?.[0]?.resourceId;
  } finally { await host.close(); }
}

it('gives the image of a session the same id after the Controller restarts, when it keeps its resource key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-ids-'));
  roots.push(root);
  const file = join(root, 'resource-id.key');
  const before = await imageIdAfterStart(file);
  expect(before).toMatch(/^rid_/);
  expect(await imageIdAfterStart(file)).toBe(before);
  const unkeyed = await imageIdAfterStart(undefined);
  expect(unkeyed).toBeDefined();
  expect(unkeyed).not.toMatch(/^rid_/);
});
