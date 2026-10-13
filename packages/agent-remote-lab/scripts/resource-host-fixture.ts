import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RESOURCE_INPUT_CAPABILITIES, type AgentInputPart, type ProviderStreamItem, type AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteRelay, createAgentRemoteHttpServer, InputResourceStore } from '@orchardworks/agent-remote-relay';
const directory = await mkdtemp(join(tmpdir(), 'remote-resource-browser-'));
const evidence = resolve(process.env.RESOURCE_BROWSER_EVIDENCE ?? '../../.artifacts/resource-browser'); await mkdir(evidence, { recursive: true });
const provider: AgentProviderAdapter = { descriptor: { providerId: 'resource-fixture', displayName: 'Resource fixture' }, async resumeSession() { throw new Error('Resume is not used.'); }, async createSession(config) {
  const queue: ProviderStreamItem[] = []; let wake: (() => void) | undefined; let closed = false;
  return {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, resourceInput: RESOURCE_INPUT_CAPABILITIES, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() { yield { type: 'history_boundary' as const }; while (!closed) { if (!queue.length) await new Promise<void>(resolve => { wake = resolve; }); while (queue.length) yield queue.shift()!; } },
    async sendMessage() {},
    async sendMessageContent(parts: readonly AgentInputPart[]) {
      const resources = await Promise.all(parts.filter(part => part.type === 'resource').map(async part => ({ resourceId: part.resourceId, name: part.name, byteLength: (await readFile(part.path)).length, sha256: createHash('sha256').update(await readFile(part.path)).digest('hex') })));
      await writeFile(join(evidence, `${config.sessionId}.json`), JSON.stringify({ types: parts.map(part => part.type), resources }));
      queue.push({ type: 'observation', sourceKey: randomUUID(), occurredAt: Date.now(), delivery: 'live', event: { type: 'timeline', provider: 'resource-fixture', item: { type: 'user_message', text: parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join(''), content: parts.map(part => part.type === 'resource' ? { type: 'resource', locator: `input-resource:${part.resourceId}`, label: part.label, name: part.name, mediaType: part.mediaType, byteLength: part.byteLength, sha256: part.sha256 } : part.type === 'text' ? part : { type: 'text', text: '[image]' }) } } }); wake?.();
    },
    async respondToInteraction() {}, async runtimeInfo() { return { providerId: 'resource-fixture', sessionId: config.sessionId, status: 'idle' as const }; }, async dispose() { closed = true; wake?.(); },
  };
} };
const relay = createAgentRemoteRelay({ providers: [provider], inputResourceStore: new InputResourceStore({ directory }) });
const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'browser-fixture' }), authorize: () => true } });
for (const agentId of ['resource-desktop', 'resource-mobile']) await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'resource-fixture', config: { sessionId: agentId } } });
await server.listen(Number(process.env.RESOURCE_BROWSER_RELAY_PORT ?? 63271), '127.0.0.1');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
