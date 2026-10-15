import { browseWorkspaceFolders, createWorkspaceFolder, WorkspaceFolderError } from '@orchardworks/agent-remote-controller';
import { isDeepStrictEqual } from 'node:util';
import { isSuccessionRequest, nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalSessionSuccession, type LocalSuccessionProvider } from '@orchardworks/agent-remote-controller/local-session-succession';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { RemoteHostCatalog, RemoteHostCatalogError, type RemoteSessionSummary } from '@orchardworks/dsh';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import type { AgentRemoteRelay } from '@orchardworks/agent-remote-relay';
import { createLocalLabMutationPolicy } from './local-authorizer.js';

export interface SessionDirectorySource {
  providerId: string;
  supportsSourceReferences?: boolean;
  /** External or unknown grants cannot be reconstructed by the direct local runtime. */
  sourceGrantState?(nativeSessionId: string): 'absent' | 'external' | 'unknown' | Promise<'absent' | 'external' | 'unknown'>;
  list(): Promise<readonly RemoteSessionSummary[]> | readonly RemoteSessionSummary[];
  workspaces(): unknown;
  models?(): unknown;
  create(input: Partial<AgentSessionConfig> & { workspaceId?: string; sourceNativeSessionId?: string }): Promise<string>;
  open(nativeSessionId: string): Promise<AgentSession>;
  openChild?(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession>;
  close?(): Promise<void>;
}

export function createSessionDirectory(providers: readonly AgentProviderAdapter[], sources: readonly SessionDirectorySource[] = [], options: { successionStateDirectory?: string } = {}) {
  const stateDirectory = resolve(options.successionStateDirectory ?? join(homedir(), '.agent-remote-control', 'lab-successions'));
  const successionProviders = providers.map((provider: LocalSuccessionProvider) => {
    const source = sources.find(source => source.providerId === provider.descriptor.providerId);
    if (!source) return provider;
    return new Proxy(provider, { get(target, key) {
      if (key === 'validatePromptEdit' && target.validatePromptEdit) return async (selection: Parameters<NonNullable<LocalSuccessionProvider['validatePromptEdit']>>[0]) => {
        await assertNoExternalGrant(source, selection.nativeSessionId);
        await target.validatePromptEdit!(selection);
      };
      if (key === 'forkForPromptEdit' && target.forkForPromptEdit) return async (...args: Parameters<NonNullable<LocalSuccessionProvider['forkForPromptEdit']>>) => {
        await assertNoExternalGrant(source, args[0].nativeSessionId);
        return target.forkForPromptEdit!(...args);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const local = new LocalSessionSuccession(stateDirectory, `lab-${createHash('sha256').update(stateDirectory).digest('hex')}`, successionProviders);

  const entries = new Map(providers.map((provider) => {
    const source = sources.find((item) => item.providerId === provider.descriptor.providerId) ?? localSource(local.providers.find(item => item.descriptor.providerId === provider.descriptor.providerId)!);
    return [source.providerId, { source, catalog: new RemoteHostCatalog({ roots: () => source.list() }) }] as const;
  }));
  const adapters = providers.map((provider): AgentProviderAdapter => ({
    descriptor: provider.descriptor,
    resumeSession: (handle) => local.providers.find(item => item.descriptor.providerId === provider.descriptor.providerId)!.resumeSession(handle),
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
        return local.ownSession(child, source.providerId);
      }
      return nativeSessionId === undefined ? local.providers.find(item => item.descriptor.providerId === provider.descriptor.providerId)!.createSession(config)
        : local.ownSession(await entries.get(provider.descriptor.providerId)!.source.open(nativeSessionId), provider.descriptor.providerId);
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
    await local.service.ready;
    if (parentNativeSessionId === undefined) {
      const state = local.service.store.all().find(state => state.role.origin.providerId === providerId && (state.role.origin.nativeSessionId === nativeSessionId || state.role.current.nativeSessionId === nativeSessionId || state.operations.some(row => row.to?.nativeSessionId === nativeSessionId)));
      if (state) {
        const external = sources.find(source => source.providerId === providerId);
        // Original custom sessions keep their directory-owned extension reconstruction.
        // A committed descendant always follows the durable role, never the retired origin.
        if (!external || state.role.current.nativeSessionId !== state.role.origin.nativeSessionId) {
          if (external) await assertNoExternalGrant(external, state.role.current.nativeSessionId);
          return { agentId: await local.attach(state.role.current), nativeSessionId: state.role.current.nativeSessionId };
        }
        nativeSessionId = state.role.current.nativeSessionId;
      }
    }
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
        await relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: {
          requestId: randomUUID(), operationId: randomUUID(), agentId, providerId,
          config: { sessionId: agentId, nativeSessionId, ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }) } as AgentSessionConfig,
        } });
        local.agentRef(agentId);
        return { agentId, nativeSessionId };
      })();
      attachments.set(key, pending);
      void pending.catch(() => { if (attachments.get(key) === pending) attachments.delete(key); });
    }
    return pending;
  };
  return {
    providers: adapters,
    operationCache: local.operationCache,
    operationLifecycle: local.operationLifecycle,
    async close() {
      await local.close();
      for (const entry of entries.values()) entry.catalog.dispose();
      await Promise.all([...entries.values()].map((entry) => entry.source.close?.()));
    },
    install(server: Server, relay: AgentRemoteRelay, origin: string) {
      local.bindRelay(relay);
      const handlers = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/v1/remote/') && url.pathname !== '/v1/session-successions' && !url.pathname.startsWith('/v1/session-successions/')) {
          for (const handler of handlers) handler.call(server, request, response);
          return;
        }
        void handle(request, response, url).catch((error) => {
          if (error instanceof DirectoryError || error instanceof RemoteHostCatalogError || error instanceof WorkspaceFolderError) send(response, error.status, { code: error.code, error: error.message });
          else send(response, (error as { status?: number }).status ?? 409, { code: 'operation_failed', error: error instanceof Error ? error.message : 'Session operation failed.' });
        });
      });
      async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
        const address = request.socket.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || (request.headers.origin && request.headers.origin !== origin)) {
          throw new DirectoryError(403, 'forbidden', 'The directory is available only to the local application.');
        }
        if (url.pathname === '/v1/session-successions' || url.pathname.startsWith('/v1/session-successions/')) {
          if (request.method !== 'GET') throw new DirectoryError(405, 'method_not_allowed', 'Method is not allowed.');
          await local.service.ready;
          return send(response, 200, local.replay.read(url.pathname, url.searchParams));
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
          if (url.pathname.startsWith('/v1/remote/succession/')) {
            if (request.headers.origin !== origin) throw new DirectoryError(403, 'forbidden', 'A same-origin request is required.');
            await local.service.ready;
            const action = url.pathname.slice('/v1/remote/succession/'.length);
            let role;
            let input = body;
            const saved = typeof body.operationId === 'string' ? local.service.store.all().flatMap(state => state.operations).find(record => record.operationId === body.operationId) : undefined;
            const hasOriginal = body.providerId !== undefined || body.nativeSessionId !== undefined;
            if (action === 'describe' || action === 'prepare' && hasOriginal || action === 'cancel' && !saved && hasOriginal) {
              const providerId = required(body.providerId, 'providerId'), nativeSessionId = required(body.nativeSessionId, 'nativeSessionId');
              const attached = await attach(relay, providerId, nativeSessionId);
              role = await local.ensureRole(local.agentRef(attached.agentId));
              if (action !== 'describe') input = { operationId: body.operationId, roleId: role.id, expectedRevision: body.expectedRevision, from: local.ref(providerId, nativeSessionId),
                ...(body.targetProviderId === undefined ? {} : { targetProviderId: body.targetProviderId }), ...(body.preparation === undefined ? {} : { preparation: body.preparation }) };
            } else {
              const roleId = required(body.roleId ?? saved?.roleId, 'roleId');
              role = local.service.store.read(roleId).role;
            }
            if (action !== 'describe' && action !== 'prepare') {
              if (saved) {
                if (body.expectedRevision !== undefined && body.expectedRevision !== saved.expectedRevision) throw new DirectoryError(409, 'request_conflict', 'The original revision changed.');
                if (hasOriginal && (body.providerId !== saved.from.providerId || body.nativeSessionId !== saved.from.nativeSessionId
                  || body.expectedRevision !== saved.expectedRevision || (body.targetProviderId ?? saved.from.providerId) !== (saved.targetProviderId ?? saved.from.providerId)
                  || !isDeepStrictEqual(body.preparation, saved.preparation))) throw new DirectoryError(409, 'request_conflict', 'The original succession identity changed.');
              } else if (action === 'cancel') {
                if (!isSuccessionRequest(input) || input.roleId !== role.id || nativeSessionRefKey(input.from) !== nativeSessionRefKey(role.current)) throw new DirectoryError(400, 'invalid_request', 'Cancellation requires its exact original request.');
                await local.service.store.begin(input, true);
              } else throw new DirectoryError(403, 'succession_unavailable', 'Succession access is unavailable.');
              input = { ...input, operationId: body.operationId, expectedRevision: saved?.expectedRevision ?? input.expectedRevision };
            }
            const result = await local.action(action, input, role);
            return send(response, 200, result);
          }
          const providerId = required(body.providerId, 'providerId');
          const { source } = requireEntry(providerId);
          if (url.pathname === '/v1/remote/workspace-folders/create') return send(response, 201, await createWorkspaceFolder(body.parentPath, body.name));
          if (url.pathname === '/v1/remote/child/attach') return send(response, 200, await attach(relay, providerId, required(body.nativeSessionId, 'nativeSessionId'), required(body.parentNativeSessionId, 'parentNativeSessionId')));
          if (url.pathname === '/v1/remote/history/attach') {
            await local.service.ready;
            const ref = local.replay.historical(required(body.roleId, 'roleId'), local.ref(providerId, required(body.nativeSessionId, 'nativeSessionId')));
            const custom = sources.find(source => source.providerId === providerId);
            const state = local.service.store.read(required(body.roleId, 'roleId'));
            const isOrigin = nativeSessionRefKey(state.role.origin) === nativeSessionRefKey(ref);
            if (custom && !isOrigin) await assertNoExternalGrant(custom, ref.nativeSessionId);
            return send(response, 200, { agentId: await local.attach(ref, custom && isOrigin ? () => custom.open(ref.nativeSessionId) : undefined), nativeSessionId: ref.nativeSessionId });
          }
          if (url.pathname === '/v1/remote/attach') return send(response, 200, await attach(relay, providerId, required(body.nativeSessionId, 'nativeSessionId')));
          if (url.pathname === '/v1/remote/create') {
            if (body.creationSource !== undefined) throw new DirectoryError(400, 'unsupported_configuration', 'Snapshot source admission is unavailable in the legacy local directory. Use a paired Host.');
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
    supportsSourceReferences: !!provider.readSessionHistory && !!provider.descriptor.sessionExtensions?.tools,
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
      sessions.set(sessionId, { config: { ...config, ...(sourceNativeSessionId ? { sourceNativeSessionId } : {}), sessionId } as AgentSessionConfig, createdAt: new Date().toISOString() });
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
async function assertNoExternalGrant(source: SessionDirectorySource, nativeSessionId: string): Promise<void> {
  const state = source.sourceGrantState ? await source.sourceGrantState(nativeSessionId) : source.supportsSourceReferences ? 'unknown' : 'absent';
  if (state !== 'absent') throw new Error('The external directory source grant cannot be reconstructed by this local runtime.');
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
