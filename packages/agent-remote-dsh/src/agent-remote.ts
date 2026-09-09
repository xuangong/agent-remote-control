import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createDshWebInteractionAdapter, type DshWebInteractionAdapter } from '@borgee/agent-provider-dsh';
import {
  createAgentRemoteRelay, createRemoteHostUplinkClient, type RemoteHostControlRequest,
} from '@borgee/agent-remote-relay';
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import Schema from '@deepseek-ai/schemastery';

import { createDshAgentRemoteProvider } from './agent-remote-provider.js';
import { watchRemoteHostSettings, type RemoteHostSettings } from './agent-remote-settings.js';
import { RemoteHostCatalog, RemoteHostCatalogError, type RemoteSessionSummary } from './remote-host-catalog.js';
import { createNativeSessionCatalog, type NativeSessionCatalogServices } from './native-session-catalog.js';
import { type DshSharedWebServices } from './shared-web-session.js';

export const name = 'agent-remote-control-host';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionController', 'sessionQuery', 'agentPresets', 'workspaceRegistry', 'userQuestions', 'approval', 'settings'];

export interface Config {
  workspace?: string;
  serverUrl?: string;
  remoteKey?: string;
  instanceName?: string;
}

export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string(),
  serverUrl: Schema.string().description('Agent Remote Control server URL for the outbound Remote Host connection.'),
  remoteKey: Schema.string().role('secret').description('Remote Host access key.'),
  instanceName: Schema.string().description('Name registered for this DSH installation. An empty value uses the host name; an omitted value falls back to AGENT_REMOTE_INSTANCE_NAME, then the host name.'),
});

export interface DshAgentRemoteHost {
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

type WebContext = Context & Partial<DshSharedWebServices> & Partial<NativeSessionCatalogServices> & {
  readonly agentDefaultModel?: { currentSelection(): ModelSelection };
};

export async function apply(context: WebContext, config: Config = {}): Promise<void> {
  await context.effect(async () => {
    const interactions = createDshWebInteractionAdapter(context);
    let host: DshAgentRemoteHost | undefined;
    let stopSettings: (() => Promise<void>) | undefined;
    const disconnect = async (): Promise<void> => {
      const current = host;
      host = undefined;
      await current?.close();
    };
    const connect = async (settings: RemoteHostSettings): Promise<void> => {
      await disconnect();
      host = await startRemoteHost(context, { ...config, ...settings }, settings.remoteKey, interactions);
      void host.ready.then(() => process.stdout.write('Agent Remote Control Agent Remote uplink registered.\n')).catch(() => undefined);
    };
    try {
      stopSettings = await watchRemoteHostSettings(context as never, config, connect, disconnect);
    } catch (error) {
      try { await disconnect(); } finally { await interactions.dispose(); }
      throw error;
    }
    return async () => {
      try { await stopSettings?.(); } finally {
        try { await disconnect(); } finally { await interactions.dispose(); }
      }
    };
  }, 'agent-remote-control-host: outbound uplink');
}

export async function startDshAgentRemote(
  context: WebContext,
  config: Config = {},
  interactions?: DshWebInteractionAdapter,
): Promise<DshAgentRemoteHost> {
  const remoteKey = config.remoteKey ?? process.env.AGENT_REMOTE_ACCESS_KEY;
  if (!remoteKey) throw new Error('Remote Host requires a pairing key.');
  return startRemoteHost(context, config, remoteKey, interactions);
}

interface Projection {
  readonly bindingId: string;
  readonly nativeSessionId: string;
  readonly agent: Agent;
}

async function startRemoteHost(
  context: WebContext,
  config: Config,
  remoteKey: string,
  interactions?: DshWebInteractionAdapter,
): Promise<DshAgentRemoteHost> {
  const url = remoteHostUplinkUrl(config.serverUrl ?? process.env.AGENT_REMOTE_SERVER_URL);
  if (!remoteKey || remoteKey.length > 512 || !/^[!-~]+$/.test(remoteKey)) {
    throw new Error('Remote Host requires a Remote Access Key without whitespace.');
  }
  const shared = requireRemoteHostServices(context);
  const installationId = await loadInstallationId();
  const instanceName = remoteHostInstanceName(config.instanceName, process.env.AGENT_REMOTE_INSTANCE_NAME);
  let provider: ReturnType<typeof createDshAgentRemoteProvider> | undefined;
  let catalog: RemoteHostCatalog | undefined;
  let relay: ReturnType<typeof createAgentRemoteRelay> | undefined;
  let uplink: ReturnType<typeof createRemoteHostUplinkClient> | undefined;
  let stopDisposed: (() => unknown) | undefined;
  let started = false;
  try {
    const dsh = createDshAgentRemoteProvider(context, interactions ? { interactions } : undefined);
    provider = dsh;
    catalog = new RemoteHostCatalog({ roots: createNativeSessionCatalog(context, createCatalogRoots(context)) });
    relay = createAgentRemoteRelay({ providers: [{
      descriptor: dsh.descriptor,
      async createSession(sessionConfig) {
        if (Object.keys(sessionConfig).length !== 1 || typeof sessionConfig.sessionId !== 'string') {
          throw new Error('Remote Host sessions must use their opaque binding identity.');
        }
        const projection = pendingProjections.get(sessionConfig.sessionId);
        if (!projection) throw new Error('Remote Host session creation was not authorized by a binding.');
        return dsh.borrowSession(projection.agent);
      },
      async resumeSession() { throw new Error('Remote Host session import is unavailable.'); },
    }] });
    const projections = new Map<string, Projection>();
    const nativeBindings = new Map<string, string>();
    const pendingProjections = new Map<string, Projection>();
    let lifecycle = Promise.resolve();
    let closing: Promise<void> | undefined;

    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const result = lifecycle.then(work, work);
      lifecycle = result.then(() => undefined, () => undefined);
      return result;
    };
    const release = async (projection: Projection): Promise<void> => {
      if (projections.get(projection.bindingId) !== projection) return;
      projections.delete(projection.bindingId);
      if (nativeBindings.get(projection.nativeSessionId) === projection.bindingId) nativeBindings.delete(projection.nativeSessionId);
      await relay!.closeAgent(projection.bindingId);
    };
    const bind = async (bindingId: string, nativeSessionId: string): Promise<void> => {
      const existingBinding = nativeBindings.get(nativeSessionId);
      const existingProjection = projections.get(bindingId);
      if ((existingBinding !== undefined && existingBinding !== bindingId)
        || (existingProjection !== undefined && existingProjection.nativeSessionId !== nativeSessionId)) {
        throw new RemoteHostRequestError(409, 'session_conflict', 'Remote Session binding conflicts with its native session.');
      }
      const agent = await resolveRootAgent(context, shared.sessionController, nativeSessionId);
      if (existingProjection?.agent === agent) return;
      if (existingProjection) await release(existingProjection);
      const projection: Projection = { bindingId, nativeSessionId, agent };
      pendingProjections.set(bindingId, projection);
      try {
        await relay!.createAgent({ protocolVersion: '1.1.0', type: 'create_agent', payload: {
          requestId: randomUUID(), agentId: bindingId, providerId: 'dsh', config: { sessionId: bindingId },
        } });
        projections.set(bindingId, projection);
        nativeBindings.set(nativeSessionId, bindingId);
      } finally {
        if (pendingProjections.get(bindingId) === projection) pendingProjections.delete(bindingId);
      }
    };
    stopDisposed = context.on('agent/disposed', ((payload: { agent: Agent }) => {
      const projection = [...projections.values()].find((candidate) => candidate.agent === payload.agent);
      if (!projection) return;
      void serialize(() => release(projection)).catch(() => undefined);
    }) as never);
    const control = async (request: RemoteHostControlRequest): Promise<{ status: number; body: string }> => {
      try {
        const url = new URL(request.path, 'http://remote-host.local');
        if (url.pathname === '/remote/attach' && request.method === 'POST') {
          const nativeSessionId = nativeSessionIdFrom(request.body);
          if (!request.sessionId) throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Session target is required.');
          await serialize(() => bind(request.sessionId!, nativeSessionId));
          return remoteHostResult(200, { nativeSessionId });
        }
        if (url.pathname === '/remote/create' && request.method === 'POST') {
          const payload = createPayload(request.body);
          if (!request.sessionId) throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Session target is required.');
          await serialize(async () => {
            const priorBinding = nativeBindings.get(payload.nativeSessionId);
            const priorProjection = projections.get(request.sessionId!);
            if ((priorBinding !== undefined && priorBinding !== request.sessionId)
              || (priorProjection !== undefined && priorProjection.nativeSessionId !== payload.nativeSessionId)) {
              throw new RemoteHostRequestError(409, 'session_conflict', 'Remote Session binding conflicts with its native session.');
            }
            const created = await shared.sessionController.create({
              sessionId: payload.nativeSessionId, ...(payload.workspaceId === undefined ? {} : { workspaceId: payload.workspaceId }),
            });
            if (created.sessionId !== payload.nativeSessionId) {
              throw new RemoteHostRequestError(503, 'mutation_outcome_unknown', 'DSH returned an unexpected native session identity.');
            }
            await bind(request.sessionId!, payload.nativeSessionId);
          });
          return remoteHostResult(200, { nativeSessionId: payload.nativeSessionId });
        }
        if (url.pathname === '/remote/workspaces' && request.method === 'GET' && !url.search) {
          return remoteHostResult(200, { workspaces: shared.workspaceRegistry.list().map(({ id, title: name, path }) => ({ id, name, path })) });
        }
        if (url.pathname === '/remote/catalog' && request.method === 'GET') {
          return remoteHostResult(200, await catalog!.page(catalogQuery(url)));
        }
        if (url.pathname === '/remote/catalog/session' && request.method === 'GET') {
          const summary = await catalog!.session(catalogSessionQuery(url));
          if (!summary) throw new RemoteHostRequestError(404, 'session_unavailable', 'The native session is unavailable.');
          return remoteHostResult(200, summary);
        }
        if (url.pathname === '/remote/catalog/revision' && request.method === 'GET' && !url.search) {
          return remoteHostResult(200, { revision: await catalog!.revision() });
        }
        throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host request is invalid.');
      } catch (error) {
        if (error instanceof RemoteHostRequestError) return remoteHostResult(error.status, { error: error.message, code: error.code });
        if (error instanceof RemoteHostCatalogError) return remoteHostResult(error.status, { error: error.message, code: error.code });
        return remoteHostResult(503, { error: 'Remote Host operation outcome is unknown.', code: 'mutation_outcome_unknown' });
      }
    };
    uplink = createRemoteHostUplinkClient({
      relay: relay!, installationId, name: instanceName, remoteKey, url,
      resolveSession: (sessionId) => {
        const projection = projections.get(sessionId);
        return projection ? relay!.requireAgent(projection.bindingId) : undefined;
      },
      control,
    });
    const close = (): Promise<void> => closing ??= (async () => {
      try { await uplink?.close(); } finally {
        try { stopDisposed?.(); } finally {
          try { await relay?.close(); } finally {
            catalog?.dispose();
            await provider?.dispose();
          }
        }
      }
    })();
    started = true;
    return { ready: uplink.ready.then(() => undefined), close };
  } finally {
    if (!started) {
      try { await uplink?.close(); } finally {
        try { stopDisposed?.(); } finally {
          try { await relay?.close(); } finally {
            try { catalog?.dispose(); } finally {
              await provider?.dispose();
            }
          }
        }
      }
    }
  }
}

function remoteHostUplinkUrl(value: string | undefined): string {
  if (!value) throw new Error('Remote Host requires a Agent Remote Control server URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Remote Host server URL is invalid.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['/', '/ws/remote-host'].includes(url.pathname)) throw new Error('Remote Host server URL must identify the Agent Remote Control origin.');
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/remote-host';
  return url.href;
}

function remoteHostInstanceName(configured: string | undefined, fromEnvironment: string | undefined): string {
  if (configured === '') return hostname();
  if (configured?.trim()) return configured;
  if (fromEnvironment?.trim()) return fromEnvironment;
  return hostname();
}

function requireRemoteHostServices(context: WebContext): Pick<DshSharedWebServices, 'sessionController' | 'workspaceRegistry'> {
  if (!context.sessionController?.create || !context.sessionController.resolveAgent) throw new Error('Remote Host requires the DSH sessionController service.');
  if (!context.workspaceRegistry?.list) throw new Error('Remote Host requires the DSH Web workspaceRegistry service.');
  return { sessionController: context.sessionController, workspaceRegistry: context.workspaceRegistry };
}

function findRootAgent(context: WebContext, sessionId: string): Agent | undefined {
  const agents = context.agents as unknown as { roots?: () => readonly Agent[] } | undefined;
  if (!agents?.roots) throw new Error('Remote Host requires the DSH Agent root registry.');
  return agents.roots().find((agent) => String(agent.session.id) === sessionId && isOrdinarySessionAgent(agent));
}

async function resolveRootAgent(
  context: WebContext,
  sessionController: DshSharedWebServices['sessionController'],
  sessionId: string,
): Promise<Agent> {
  const live = findRootAgent(context, sessionId);
  if (live) return live;
  const resolved = await sessionController.resolveAgent(sessionId);
  if ('agent' in resolved) {
    if (isOrdinarySessionAgent(resolved.agent)) return resolved.agent;
    throw new RemoteHostRequestError(404, 'session_unavailable', 'Native Remote Session is unavailable.');
  }
  if (isUnavailableNativeSessionError(resolved.error)) {
    throw new RemoteHostRequestError(404, 'session_unavailable', 'Native Remote Session is unavailable.');
  }
  throw new RemoteHostRequestError(503, 'session_recovery_failed', 'Native Remote Session recovery failed.');
}

function isOrdinarySessionAgent(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent';
}

function isUnavailableNativeSessionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'session/not-found' || code === 'session/agent-busy';
}

interface NativeCatalogEvent {
  readonly type: string;
  readonly time: unknown;
  readonly data: unknown;
}

interface NativeCatalogMetadata {
  readonly session: Agent['session'];
  events: readonly NativeCatalogEvent[];
  eventCount: number;
  latestTime: number;
  title?: string;
  firstUserPrompt?: string;
}

function createCatalogRoots(context: WebContext): () => readonly RemoteSessionSummary[] {
  const metadata = new WeakMap<Agent, NativeCatalogMetadata>();
  return () => catalogRoots(context, metadata);
}

function catalogRoots(context: WebContext, metadata: WeakMap<Agent, NativeCatalogMetadata>): readonly RemoteSessionSummary[] {
  const agents = context.agents as unknown as { roots?: () => readonly Agent[] } | undefined;
  if (!agents?.roots) return [];
  return agents.roots().filter(isOrdinarySessionAgent).map((agent) => {
    const summary = catalogMetadata(agent, metadata);
    const header = agent.session.header;
    const model = catalogModel(agent);
    return {
      nativeSessionId: String(agent.session.id), providerId: 'dsh',
      title: summary.title ?? summary.firstUserPrompt ?? String(agent.session.id),
      ...(typeof header.cwd === 'string' ? { workspace: header.cwd } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      createdAt: isoTime(header.createdAt), updatedAt: isoTime(summary.latestTime),
      state: agent.status === 'running' ? 'running' : 'idle',
    };
  });
}

function catalogMetadata(agent: Agent, cache: WeakMap<Agent, NativeCatalogMetadata>): NativeCatalogMetadata {
  const session = agent.session;
  const events = session.snapshotEvents() as readonly NativeCatalogEvent[];
  let metadata = cache.get(agent);
  if (!metadata || metadata.session !== session || events.length < metadata.eventCount) {
    metadata = {
      session, events: [], eventCount: 0,
      latestTime: timestamp(session.header.createdAt),
    };
    cache.set(agent, metadata);
  }
  if (metadata.events === events) return metadata;
  for (let index = metadata.eventCount; index < events.length; index += 1) {
    applyCatalogEvent(metadata, events[index]!);
  }
  metadata.events = events;
  metadata.eventCount = events.length;
  return metadata;
}

function applyCatalogEvent(metadata: NativeCatalogMetadata, event: NativeCatalogEvent): void {
  metadata.latestTime = Math.max(metadata.latestTime, timestamp(event.time));
  if (event.type === 'session/title') {
    const title = nonEmptyString(event.data, 'title');
    if (title !== undefined) metadata.title = title;
    return;
  }
  if (event.type !== 'user/message' || metadata.firstUserPrompt !== undefined) return;
  const prompt = firstUserPrompt(event.data);
  if (prompt !== undefined) metadata.firstUserPrompt = prompt;
}

function catalogModel(agent: Agent): string | undefined {
  const requestModel = agent.session.requestHeader()?.config.model;
  return typeof requestModel === 'string' ? requestModel : agent.options.model;
}

function firstUserPrompt(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.source) || value.source.kind !== 'user' || !Array.isArray(value.content)) return undefined;
  const text = value.content
    .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || undefined;
}

function nonEmptyString(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== 'string') return undefined;
  const text = value[key].trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isoTime(value: unknown): string {
  return new Date(timestamp(value)).toISOString();
}

function catalogQuery(url: URL): { limit?: number; cursor?: string } {
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => key !== 'limit' && key !== 'cursor')
    || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host catalog query is invalid.');
  }
  const limit = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
  return {
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(cursor === null ? {} : { cursor }),
  };
}

function catalogSessionQuery(url: URL): string {
  const entries = [...url.searchParams.entries()];
  const nativeSessionId = url.searchParams.get('nativeSessionId');
  if (entries.length !== 1 || !nativeSessionId?.trim() || nativeSessionId.length > 255) {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host metadata query requires one nativeSessionId.');
  }
  return nativeSessionId;
}

function nativeSessionIdFrom(body: string | undefined): string {
  const value = parseJsonObject(body);
  if (Object.keys(value).length !== 1 || typeof value.nativeSessionId !== 'string' || !value.nativeSessionId || value.nativeSessionId.length > 512) {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host request requires one nativeSessionId.');
  }
  return value.nativeSessionId;
}

function createPayload(body: string | undefined): { nativeSessionId: string; workspaceId?: string } {
  const value = parseJsonObject(body);
  if (Object.keys(value).some((key) => key !== 'nativeSessionId' && key !== 'workspaceId')) {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host create request is invalid.');
  }
  if (typeof value.nativeSessionId !== 'string' || !value.nativeSessionId || value.nativeSessionId.length > 512
    || (value.workspaceId !== undefined && (typeof value.workspaceId !== 'string' || !value.workspaceId))) {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host create request is invalid.');
  }
  return { nativeSessionId: value.nativeSessionId, ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}) };
}

function parseJsonObject(body: string | undefined): Record<string, unknown> {
  if (body === undefined) throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host request requires a JSON body.');
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new RemoteHostRequestError(400, 'invalid_request', 'Remote Host request body must be a JSON object.');
  }
}

function remoteHostResult(status: number, body: object): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

class RemoteHostRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function loadInstallationId(): Promise<string> {
  const directory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-remote-control');
  const identity = join(directory, 'identity.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    return await readInstallationId(identity);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const temporary = join(directory, `.identity-${process.pid}-${randomUUID()}.tmp`);
  const generated = randomUUID();
  try {
    await writeFile(temporary, `${JSON.stringify({ installationId: generated })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, identity);
      return generated;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return readInstallationId(identity);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readInstallationId(path: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || typeof (parsed as { installationId?: unknown }).installationId !== 'string'
    || !(parsed as { installationId: string }).installationId) {
    throw new Error('Remote Host installation identity is invalid.');
  }
  await chmod(path, 0o600);
  return (parsed as { installationId: string }).installationId;
}

function isMissingFile(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function isAlreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'EEXIST'; }
