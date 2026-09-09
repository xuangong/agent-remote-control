import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  validateInteractionResponse,
  type AgentCapabilities, type AgentInteractionRequest, type AgentInteractionResponse,
  type AgentProviderAdapter, type AgentSession, type AgentStreamEvent, type ProviderStreamItem,
} from '@borgee/agent-provider-sdk';
import { createProtocolValidationServer } from '../server.js';

const providerId = 'interaction-fixture';
const requests: AgentInteractionRequest[] = [
  { kind: 'form', requestId: 'fixture-form', title: 'Connect a project', message: 'Configure the project connection and review the requested access.', fields: [
    { type: 'text', fieldId: 'email', label: 'Contact email', required: true, format: 'email' },
    { type: 'text', fieldId: 'token', label: 'Access token', required: true, sensitive: true, minLength: 4 },
    { type: 'number', fieldId: 'retries', label: 'Retry limit', required: true, integer: true, minimum: 1, maximum: 3 },
    { type: 'boolean', fieldId: 'telemetry', label: 'Share diagnostics', required: true },
    { type: 'select', fieldId: 'region', label: 'Region', required: true, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }] },
    { type: 'multiselect', fieldId: 'features', label: 'Features', required: true, minItems: 1, maxItems: 2, options: [{ value: 'search', label: 'Search' }, { value: 'reports', label: 'Reports' }] },
  ] },
  { kind: 'permission_approval', requestId: 'fixture-permission', summary: 'Read project files and connect to the project API for this turn.', permissions: [
    { resource: 'filesystem', access: 'read', target: '/workspace/project' },
    { resource: 'network', access: 'connect', target: 'api.example.test' },
  ], allowScopes: ['turn'] },
  { kind: 'external_action', requestId: 'fixture-external', title: 'Verify the project connection', message: 'Complete the verification, then return here to acknowledge it.', url: 'https://example.test/verify' },
  { kind: 'tool_approval', requestId: 'fixture-policy', toolCallId: 'fixture-read', toolName: 'Read project configuration', summary: 'Choose the exact policy for reading this project.', detail: { type: 'read', filePath: '/workspace/project/config.json' }, allowedDecisions: ['allow', 'cancel'], allowScopes: ['policy'], policies: [{ policyId: 'project-read', description: 'Allow project reads' }], context: [{ label: 'Applies to', value: '/workspace/project/**' }] },
];
const expectedResponses: AgentInteractionResponse[] = [
  { kind: 'form', action: 'submit', values: { email: 'developer@example.test', token: '  browser-secret  ', retries: 2, telemetry: false, region: 'eu', features: ['search', 'reports'] } },
  { kind: 'permission_approval', decision: 'allow', scope: 'turn' },
  { kind: 'external_action', action: 'completed' },
  { kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: 'project-read' },
];

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: true, form: true, permissionApproval: true, externalAction: true },
};

/** A deterministic provider verifies exact commands while the production Relay owns public recovery. */
export function createInteractionFixtureProvider(): AgentProviderAdapter {
  return {
    descriptor: { providerId, displayName: 'Interaction validation Provider' },
    async createSession(config) { return new InteractionFixtureSession(config.sessionId); },
    async resumeSession() { throw new Error('Fixture native restart is unsupported.'); },
  };
}

class InteractionFixtureSession implements AgentSession {
  readonly capabilities = capabilities;
  private readonly queue: ProviderStreamItem[] = [];
  private reader?: (item: IteratorResult<ProviderStreamItem>) => void;
  private closed = false;
  private interactionIndex = 0;
  private source = 0;

  constructor(private readonly sessionId: string) {
    this.emit({ type: 'interaction_requested', provider: providerId, request: requests[0]! }, 'history');
    this.queue.push({ type: 'history_boundary' });
  }

  observe(): AsyncIterable<ProviderStreamItem> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      const item = this.queue.shift();
      if (item) return { done: false, value: item };
      if (this.closed) return { done: true, value: undefined };
      return new Promise<IteratorResult<ProviderStreamItem>>((resolve) => { this.reader = resolve; });
    } }) };
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    const request = requests[this.interactionIndex];
    if (!request || request.requestId !== requestId) throw new Error('Fixture request is no longer pending.');
    validateInteractionResponse(request, response);
    if (!isDeepStrictEqual(response, expectedResponses[this.interactionIndex])) throw new Error('Fixture command differs from the expected choices.');
    // The Relay must sanitize receipts even when a provider emits the original command response.
    this.emit({ type: 'interaction_resolved', provider: providerId, requestId, response });
    this.interactionIndex += 1;
    const next = requests[this.interactionIndex];
    if (next) this.emit({ type: 'interaction_requested', provider: providerId, request: next });
    else this.emit({ type: 'timeline', provider: providerId, item: { type: 'assistant_message', messageId: 'fixture-completed', text: 'The fixture verified all four exact interaction responses.' } });
  }

  async sendMessage(): Promise<void> { throw new Error('Use the interaction controls in this fixture.'); }
  async runtimeInfo() { return { providerId, sessionId: this.sessionId, status: 'idle' as const, mode: 'deterministic' }; }
  async dispose(): Promise<void> { this.closed = true; this.reader?.({ done: true, value: undefined }); this.reader = undefined; }

  private emit(event: AgentStreamEvent, delivery: 'live' | 'history' = 'live'): void {
    const item: ProviderStreamItem = { type: 'observation', sourceKey: `interaction-fixture-${++this.source}`, occurredAt: Date.now(), delivery, event };
    if (this.reader) { const reader = this.reader; this.reader = undefined; reader({ done: false, value: item }); }
    else this.queue.push(item);
  }
}

const entry = process.argv[1] === undefined ? undefined : new URL(`file://${process.argv[1]}`).href;
if (entry === import.meta.url) {
  const labOrigin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6287';
  const server = createProtocolValidationServer({
    providers: [createInteractionFixtureProvider()],
    labOrigin,
  });
  const sockets = new Set<Duplex>();
  server.http.server.on('upgrade', (request, socket) => {
    if (!request.url?.startsWith('/v1/sessions/')) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const [relayRequest] = server.http.server.listeners('request') as Array<(request: IncomingMessage, response: ServerResponse) => void>;
  if (!relayRequest) throw new Error('Fixture Relay request handler is missing.');
  server.http.server.removeListener('request', relayRequest);
  server.http.server.on('request', (request, response) => {
    if (request.url !== '/v1/lab/interactions/disconnect') { relayRequest(request, response); return; }
    if (request.method !== 'POST' || request.headers.origin !== labOrigin) { response.writeHead(403).end(); return; }
    for (const socket of sockets) socket.destroy();
    response.writeHead(204).end();
  });
  const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT ?? 6016), '127.0.0.1');
  process.stdout.write(`Interaction fixture Relay listening on ${address.url}\n`);
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}
