import { sourceSessionExtensions, browseWorkspaceFolders, createWorkspaceFolder, WorkspaceFolderError } from '@orchardworks/agent-remote-controller';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { RemoteHostCatalog, RemoteHostCatalogError, type RemoteSessionSummary } from '@orchardworks/dsh';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import type { AgentRemoteRelay } from '@orchardworks/agent-remote-relay';
import { createLocalLabMutationPolicy } from './local-authorizer.js';

export interface SessionDirectorySource {
  providerId: string;
  supportsSourceReferences?: boolean;
  list(): Promise<readonly RemoteSessionSummary[]> | readonly RemoteSessionSummary[];
  workspaces(): unknown;
  models?(): unknown;
  create(input: Partial<AgentSessionConfig> & { workspaceId?: string; sourceNativeSessionId?: string }): Promise<string>;
  open(nativeSessionId: string): Promise<AgentSession>;
  openChild?(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession>;
  close?(): Promise<void>;
}

export function createSessionDirectory(providers: readonly AgentProviderAdapter[], sources: readonly SessionDirectorySource[] = []) {
  const entries = new Map(providers.map((provider) => {
    const source = sources.find((item) => item.providerId === provider.descriptor.providerId) ?? localSource(provider);
    return [source.providerId, { source, catalog: new RemoteHostCatalog({ roots: () => source.list() }) }] as const;
  }));
  const adapters = providers.map((provider): AgentProviderAdapter => ({
    descriptor: provider.descriptor,
    resumeSession: (handle) => provider.resumeSession(handle),
    async createSession(config) {
      const { nativeSessionId, parentNativeSessionId } = config as AgentSessionConfig & { nativeSessionId?: string; parentNativeSessionId?: string };
      if (nativeSessionId && parentNativeSessionId) {
        const source = entries.get(provider.descriptor.providerId)!.source;
        if (!source.openChild) throw new DirectoryError(409, 'child_control_unavailable', 'This Provider cannot attach native child sessions.');
        const child = await source.openChild(parentNativeSessionId, nativeSessionId);
        const info = await child.runtimeInfo();
        if (info.sessionId !== nativeSessionId || info.providerId !== source.providerId) {
          throw new DirectoryError(409, 'child_identity_mismatch', 'The Provider returned a different native child session.');
        }
        return child;
      }
      return nativeSessionId === undefined ? provider.createSession(config)
        : entries.get(provider.descriptor.providerId)!.source.open(nativeSessionId);
    },
  }));
  const attachments = new Map<string, Promise<{ agentId: string; nativeSessionId: string }>>();
  const requests = new Map<string, { fingerprint: string; result: Promise<{ agentId: string; nativeSessionId: string }> }>();
  const requireEntry = (providerId: string) => {
    const entry = entries.get(providerId);
    if (!entry) throw new DirectoryError(404, 'provider_not_found', 'The Provider is unavailable.');
    return entry;
  };
  const attach = async (relay: AgentRemoteRelay, providerId: string, nativeSessionId: string, parentNativeSessionId?: string): Promise<{ agentId: string; nativeSessionId: string }> => {
    if (parentNativeSessionId !== undefined) {
      const entry = requireEntry(providerId);
      if (!entry.source.openChild) throw new DirectoryError(409, 'child_control_unavailable', 'This Provider cannot attach native child sessions.');
      const parentAttachment = attachments.get(JSON.stringify([providerId, parentNativeSessionId]));
      if (!parentAttachment) throw new DirectoryError(409, 'parent_unavailable', 'Open the parent session before its child.');
      const parent = await parentAttachment;
      let parentState;
      try { parentState = relay.requireAgent(parent.agentId).snapshot().payload; }
      catch { throw new DirectoryError(409, 'parent_unavailable', 'The parent session is no longer attached.'); }
      if (parentState.runtimeInfo.sessionId !== parentNativeSessionId || parentState.status === 'closed') {
        throw new DirectoryError(409, 'parent_unavailable', 'The parent runtime is unavailable.');
      }
      if (!parentState.runtimeInfo.childSessions?.some((child) => child.nativeSessionId === nativeSessionId)) {
        throw new DirectoryError(404, 'child_unavailable', 'This session is not a discovered direct child of the parent.');
      }
    }
    const key = JSON.stringify([providerId, nativeSessionId]);
    let pending = attachments.get(key);
    if (pending) {
      const existing = await pending;
      try { relay.requireAgent(existing.agentId); return existing; } catch {
        if (attachments.get(key) === pending) attachments.delete(key);
        pending = attachments.get(key);
      }
    }
    if (!pending) {
      pending = (async () => {
        const entry = requireEntry(providerId);
        if (parentNativeSessionId === undefined && !await entry.catalog.session(nativeSessionId)) throw new DirectoryError(404, 'session_unavailable', 'The native session is unavailable.');
        const agentId = randomUUID();
        await relay.createAgent({ protocolVersion: '1.5.0', type: 'create_agent', payload: {
          requestId: randomUUID(), operationId: randomUUID(), agentId, providerId,
          config: { sessionId: agentId, nativeSessionId, ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }) } as AgentSessionConfig,
        } });
        return { agentId, nativeSessionId };
      })();
      attachments.set(key, pending);
      void pending.catch(() => { if (attachments.get(key) === pending) attachments.delete(key); });
    }
    return pending;
  };
  return {
    providers: adapters,
    async close() {
      for (const entry of entries.values()) entry.catalog.dispose();
      await Promise.all([...entries.values()].map((entry) => entry.source.close?.()));
    },
    install(server: Server, relay: AgentRemoteRelay, origin: string) {
      const handlers = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/v1/remote/')) {
          for (const handler of handlers) handler.call(server, request, response);
          return;
        }
        void handle(request, response, url).catch((error) => {
          if (error instanceof DirectoryError || error instanceof RemoteHostCatalogError || error instanceof WorkspaceFolderError) send(response, error.status, { code: error.code, error: error.message });
          else send(response, 503, { code: 'operation_failed', error: error instanceof Error ? error.message : 'Session operation failed.' });
        });
      });
      async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
        const address = request.socket.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || (request.headers.origin && request.headers.origin !== origin)) {
          throw new DirectoryError(403, 'forbidden', 'The directory is available only to the local application.');
        }
        if (request.method === 'GET') {
          const providerId = required(url.searchParams.get('providerId'), 'providerId');
          const { source, catalog } = requireEntry(providerId);
          if (url.pathname === '/v1/remote/catalog') {
            const limit = url.searchParams.get('limit'); const cursor = url.searchParams.get('cursor');
            return send(response, 200, await catalog.page({ ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }) }));
          }
          if (url.pathname === '/v1/remote/catalog/revision') return send(response, 200, { revision: await catalog.revision() });
          if (url.pathname === '/v1/remote/workspace-folders') {
            const workspaces = await source.workspaces();
            const first = Array.isArray(workspaces) ? workspaces[0] : undefined;
            return send(response, 200, await browseWorkspaceFolders(url.searchParams, undefined, typeof first?.path === 'string' ? first.path : undefined));
          }
          if (url.pathname === '/v1/remote/workspaces') return send(response, 200, { workspaces: await source.workspaces() });
          if (url.pathname === '/v1/remote/models') return send(response, 200, await source.models?.() ?? { models: [] });
        }
        if (request.method === 'POST') {
          const access = createLocalLabMutationPolicy(origin).validate(request);
          if (access.status === 'rejected') throw new DirectoryError(access.httpStatus, access.code, access.message);
          const body = await readBody(request);
          const providerId = required(body.providerId, 'providerId');
          const { source } = requireEntry(providerId);
          if (url.pathname === '/v1/remote/workspace-folders/create') return send(response, 201, await createWorkspaceFolder(body.parentPath, body.name));
          if (url.pathname === '/v1/remote/child/attach') return send(response, 200, await attach(relay, providerId, required(body.nativeSessionId, 'nativeSessionId'), required(body.parentNativeSessionId, 'parentNativeSessionId')));
          if (url.pathname === '/v1/remote/attach') return send(response, 200, await attach(relay, providerId, required(body.nativeSessionId, 'nativeSessionId')));
          if (url.pathname === '/v1/remote/create') {
            const operationId = required(body.operationId, 'operationId');
            const config: Partial<AgentSessionConfig> & { workspaceId?: string; sourceNativeSessionId?: string } = {};
            for (const key of ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'sourceNativeSessionId'] as const) {
              if (body[key] !== undefined) config[key] = required(body[key], key);
            }
            if (config.sourceNativeSessionId && !source.supportsSourceReferences) throw new DirectoryError(400, 'unsupported_configuration', 'This Host/provider does not support source-session tools. Update the Host or use /fork.');
            if (body.planning !== undefined) {
              if (typeof body.planning !== 'boolean') throw new DirectoryError(400, 'invalid_request', 'planning must be boolean.');
              config.planning = body.planning;
            }
            const key = JSON.stringify([providerId, operationId]);
            const fingerprint = JSON.stringify(config);
            let request = requests.get(key);
            if (request && request.fingerprint !== fingerprint) throw new DirectoryError(409, 'request_conflict', 'This request identity was already used with different settings.');
            if (!request) {
              if (requests.size >= 4096) throw new DirectoryError(429, 'capacity_exceeded', 'The session creation ledger is full; restart the local host before creating more sessions.');
              request = { fingerprint, result: source.create(config).then((nativeId) => attach(relay, providerId, nativeId)) };
              requests.set(key, request);
            }
            return send(response, 200, await request.result);
          }
        }
        throw new DirectoryError(404, 'route_not_found', 'Unknown session directory route.');
      }
    },
  };
}

function localSource(provider: AgentProviderAdapter): SessionDirectorySource {
  const providerId = provider.descriptor.providerId;
  const sessions = new Map<string, { config: AgentSessionConfig; createdAt: string }>();
  if (providerId === 'recorded') sessions.set('recorded-welcome', { config: { sessionId: 'recorded-welcome' }, createdAt: new Date().toISOString() });
  return {
    providerId,
    supportsSourceReferences: !!provider.readSessionHistory,
    list: () => [...sessions].map(([nativeSessionId, { config, createdAt }]) => ({
      nativeSessionId, providerId, title: nativeSessionId === 'recorded-welcome' ? 'Recorded welcome session' : nativeSessionId,
      workspace: config.cwd, model: config.model, createdAt, updatedAt: createdAt, state: 'idle',
    })),
    workspaces: () => [],
    async create(input) {
      if (input.workspaceId !== undefined) throw new DirectoryError(400, 'invalid_request', 'This Provider uses a workspace path.');
      const sessionId = randomUUID();
      const { sourceNativeSessionId, ...config } = input;
      if (sourceNativeSessionId && !sessions.has(sourceNativeSessionId)) throw new DirectoryError(404, 'session_unavailable', 'The source session is unavailable.');
      const extensions = sourceNativeSessionId && provider.readSessionHistory ? sourceSessionExtensions(sourceNativeSessionId, provider.readSessionHistory.bind(provider)) : {};
      sessions.set(sessionId, { config: { ...config, ...extensions, sessionId }, createdAt: new Date().toISOString() });
      return sessionId;
    },
    async open(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new DirectoryError(404, 'session_unavailable', 'The local session is unavailable.');
      return provider.createSession(session.config);
    },
  };
}

class DirectoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new DirectoryError(400, 'invalid_request', `${field} must be a nonempty string.`);
  return value;
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 64 * 1024) throw new DirectoryError(413, 'request_too_large', 'The directory request is too large.');
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new DirectoryError(400, 'invalid_request', 'The directory requires a JSON object.'); }
}
function send(response: ServerResponse, status: number, body: unknown) {
  if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
