import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import type { AgentHistoryPage, AgentHistoryQuery, AgentSessionHostAccess } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';

/** The variables through which a session's shell commands reach this Controller as that session. */
export const SESSION_TOKEN_VARIABLE = 'AGENT_REMOTE_SESSION_TOKEN';
export const SESSION_SOCKET_VARIABLE = 'AGENT_REMOTE_SESSION_SOCKET';
/** Sessions whose credentials are kept; the oldest is forgotten first and gets a new one on its next attachment. */
const TOKEN_LIMIT = 4096;
/** Sessions of share recipients that are kept hidden; far more than one Host's recipients create. */
const SHARED_LIMIT = 16_384;
const REQUEST_BYTES = 64 * 1024;

export interface SessionCallerRef { providerId: string; nativeSessionId: string }
const refKey = (ref: SessionCallerRef) => JSON.stringify([ref.providerId, ref.nativeSessionId]);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

interface SavedCallers { version: 1; sessions: Array<SessionCallerRef & { token: string }>; shared: SessionCallerRef[] }

/**
 * The credentials of the sessions this Controller manages, and the sessions share recipients created.
 *
 * One credential per native session, kept across Controller restarts: a shared Codex daemon keeps loaded threads, with
 * the environment they were given, while the Controller restarts. A share recipient's session gets none: marking it
 * revokes the credential it may hold, and it is never issued one again.
 */
export class SessionCallerStore {
  private readonly tokens = new Map<string, SessionCallerRef & { token: string }>();
  private readonly byDigest = new Map<string, SessionCallerRef>();
  private readonly shared = new Map<string, SessionCallerRef>();
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly path: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let saved: SavedCallers;
    try { saved = JSON.parse(await readFile(this.path, 'utf8')) as SavedCallers; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Saved session credentials could not be read.');
    }
    if (saved?.version !== 1 || !Array.isArray(saved.sessions) || !Array.isArray(saved.shared)) throw new Error('Saved session credentials are invalid.');
    for (const ref of saved.shared) if (validRef(ref)) this.shared.set(refKey(ref), { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId });
    for (const entry of saved.sessions) if (validRef(entry) && typeof entry.token === 'string' && entry.token.length >= 32) this.remember(entry, entry.token);
  }

  /** The credential of an existing native session, issued on first use; none for a share recipient's session. */
  async issue(ref: SessionCallerRef): Promise<string | undefined> {
    await this.ready;
    if (this.shared.has(refKey(ref))) return undefined;
    const existing = this.tokens.get(refKey(ref));
    if (existing) return existing.token;
    const token = randomBytes(32).toString('base64url');
    this.remember(ref, token);
    await this.save();
    return token;
  }

  /** A credential for a session not created yet; it identifies nobody until bound to the native identity. */
  prepare(): { token: string; bind(ref: SessionCallerRef): Promise<void> } {
    const token = randomBytes(32).toString('base64url');
    return { token, bind: async ref => {
      await this.ready;
      if (this.shared.has(refKey(ref))) return;
      this.forget(ref);
      this.remember(ref, token);
      await this.save();
    } };
  }

  identify(token: unknown): SessionCallerRef | undefined {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return undefined;
    const ref = this.byDigest.get(digest(token));
    return ref && { ...ref };
  }

  isShared(ref: SessionCallerRef): boolean { return this.shared.has(refKey(ref)); }

  /** Hides a share recipient's session and revokes its credential. */
  async markShared(ref: SessionCallerRef): Promise<void> {
    await this.ready;
    const key = refKey(ref);
    if (this.shared.has(key) && !this.tokens.has(key)) return;
    this.forget(ref);
    this.shared.delete(key);
    this.shared.set(key, { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId });
    while (this.shared.size > SHARED_LIMIT) this.shared.delete(this.shared.keys().next().value!);
    await this.save();
  }

  private remember(ref: SessionCallerRef, token: string): void {
    const entry = { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, token };
    this.tokens.set(refKey(ref), entry);
    this.byDigest.set(digest(token), { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId });
    while (this.tokens.size > TOKEN_LIMIT) this.forget(this.tokens.values().next().value!);
  }

  private forget(ref: SessionCallerRef): void {
    const existing = this.tokens.get(refKey(ref));
    if (!existing) return;
    this.tokens.delete(refKey(ref));
    this.byDigest.delete(digest(existing.token));
  }

  private save(): Promise<void> {
    const saved: SavedCallers = { version: 1, sessions: [...this.tokens.values()], shared: [...this.shared.values()] };
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await atomicWriteFile(this.path, JSON.stringify(saved));
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

function validRef(value: unknown): value is SessionCallerRef {
  const ref = value as Partial<SessionCallerRef> | null;
  return typeof ref?.providerId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(ref.providerId)
    && typeof ref.nativeSessionId === 'string' && !!ref.nativeSessionId && ref.nativeSessionId.length <= 512;
}

/** Where sessions reach this Controller: stable for its state directory, so sessions that outlive a restart still find it. */
export interface SessionCallerEndpoint {
  /** The path the Controller listens on. */
  listen: string;
  /** The same socket with every symbolic link resolved, as sessions and their sandboxes are given it. */
  access: string;
}
export async function sessionCallerEndpoint(stateDirectory: string): Promise<SessionCallerEndpoint> {
  const scope = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 16);
  if (process.platform === 'win32') { const pipe = `\\\\.\\pipe\\arc-sessions-${scope}`; return { listen: pipe, access: pipe }; }
  const listen = join(tmpdir(), `arc-sessions-${scope}.sock`);
  return { listen, access: join(await realpath(dirname(listen)), basename(listen)) };
}

/** What a directory gives the sessions it creates and resumes. */
export interface SessionHostAccessSource {
  /** Access for a session about to be created; bind() names the session once its native identity is known. */
  creation(): { hostAccess: AgentSessionHostAccess; bind(nativeSessionId: string): Promise<void> };
  /** Access for an existing session; none for a session a share recipient created. */
  session(nativeSessionId: string): Promise<AgentSessionHostAccess | undefined>;
}
export function sessionHostAccess(store: SessionCallerStore, providerId: string, endpoint: SessionCallerEndpoint, skills?: string): SessionHostAccessSource {
  const access = (token: string): AgentSessionHostAccess => ({ environment: { [SESSION_TOKEN_VARIABLE]: token, [SESSION_SOCKET_VARIABLE]: endpoint.access },
    unixSockets: process.platform === 'win32' ? [] : [endpoint.access], ...(skills ? { skills } : {}) });
  return {
    creation() {
      const prepared = store.prepare();
      return { hostAccess: access(prepared.token), bind: nativeSessionId => prepared.bind({ providerId, nativeSessionId }) };
    },
    async session(nativeSessionId) {
      const token = await store.issue({ providerId, nativeSessionId });
      return token ? access(token) : undefined;
    },
  };
}

export type SessionCallerState = 'running' | 'waiting' | 'idle' | 'failed' | 'unknown';
/** The Host's sessions as the session commands see them. */
export interface SessionCallerCatalog {
  /** The Host's enabled providers. */
  providers(): readonly string[];
  /** The sessions a provider's catalog lists, which follows the Host's workspace policy. */
  sessions(providerId: string): Promise<readonly RemoteSessionSummary[]>;
  session(ref: SessionCallerRef): Promise<RemoteSessionSummary | undefined>;
  history(ref: SessionCallerRef, query: AgentHistoryQuery): Promise<AgentHistoryPage>;
  /** The state of a session this Controller holds open. */
  liveState(ref: SessionCallerRef): SessionCallerState | undefined;
}

export class SessionCallError extends Error {
  constructor(readonly code: 'invalid_request' | 'no_session_identity' | 'session_forbidden' | 'session_not_found' | 'history_unavailable', message: string) { super(message); }
}

const LIST_LIMIT = 50;
const HISTORY_LIMIT = 10;

/** Answers one session command from a session's shell. The caller is the session its credential names. */
export async function handleSessionCall(input: unknown, context: { store: SessionCallerStore; catalog: SessionCallerCatalog; hostId(): Promise<string | undefined> }): Promise<Record<string, unknown>> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionCallError('invalid_request', 'The session command is invalid.');
    const request = input as Record<string, unknown>;
    await context.store.ready;
    const caller = context.store.identify(request.token);
    if (!caller || context.store.isShared(caller)) throw new SessionCallError('no_session_identity', 'This shell does not belong to a session this Controller manages.');
    // Until the Relay registers the Host, its sessions are addressed as local.
    const host = await context.hostId() ?? 'local';
    const address = (ref: SessionCallerRef) => `${host}/${ref.providerId}/${ref.nativeSessionId}`;
    const self = (ref: SessionCallerRef) => refKey(ref) === refKey(caller) ? { self: true } : {};
    const state = (ref: SessionCallerRef, summary?: RemoteSessionSummary): SessionCallerState => context.catalog.liveState(ref)
      ?? (summary?.state === 'unavailable' ? 'failed' : summary?.state ?? 'unknown');
    if (request.command === 'list') {
      const providerId = optionalString(request.providerId, 'providerId', 64);
      const limit = optionalInteger(request.limit, 'limit', 1, LIST_LIMIT) ?? 20;
      let offset = 0;
      if (request.cursor !== undefined) {
        const cursor = decodeCursor(request.cursor);
        if (cursor.limit !== limit || cursor.providerId !== (providerId ?? null)) throw new SessionCallError('invalid_request', 'The cursor belongs to another listing.');
        offset = cursor.offset;
      }
      const providers = context.catalog.providers();
      if (providerId !== undefined && !providers.includes(providerId)) throw new SessionCallError('invalid_request', 'The provider is unavailable on this Host.');
      const unavailable: string[] = [];
      const listed = await Promise.all((providerId === undefined ? providers : [providerId]).map(id => context.catalog.sessions(id)
        .catch(() => { unavailable.push(id); return []; })));
      const summaries = listed.flat().filter(summary => !context.store.isShared(summary))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || refKey(left).localeCompare(refKey(right)));
      const page = summaries.slice(offset, offset + limit);
      return { result: {
        sessions: page.map(summary => ({ address: address(summary), providerId: summary.providerId, title: summary.title,
          ...(summary.workspace ? { cwd: summary.workspace } : {}), updatedAt: summary.updatedAt, state: state(summary, summary), ...self(summary) })),
        ...(offset + limit < summaries.length ? { nextCursor: encodeCursor({ offset: offset + limit, limit, providerId: providerId ?? null }) } : {}),
        ...(unavailable.length ? { unavailableProviders: unavailable.sort() } : {}),
      } };
    }
    if (request.command === 'read') {
      const target = parseTarget(request.target, caller, host);
      if (context.store.isShared(target)) throw new SessionCallError('session_not_found', 'No such session on this Host.');
      const query = historyQuery(request);
      const summary = await context.catalog.session(target);
      if (!summary && refKey(target) !== refKey(caller)) throw new SessionCallError('session_not_found', 'No such session on this Host.');
      let page: AgentHistoryPage;
      try { page = await context.catalog.history(target, query); }
      catch (error) {
        if ((error as { code?: unknown }).code === 'native_session_unavailable') throw new SessionCallError('session_not_found', 'No such session on this Host.');
        throw new SessionCallError('history_unavailable', 'The session history could not be read.');
      }
      return { result: {
        session: { address: address(target), providerId: target.providerId, ...(summary ? { title: summary.title } : {}),
          ...(summary?.workspace ? { cwd: summary.workspace } : {}), ...(summary?.model ? { model: summary.model } : {}), state: state(target, summary), ...self(target) },
        entries: page.entries, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      } };
    }
    throw new SessionCallError('invalid_request', 'Unknown session command.');
  } catch (error) {
    if (error instanceof SessionCallError) return { error: { code: error.code, message: error.message } };
    return { error: { code: 'history_unavailable', message: 'The Controller could not answer the session command.' } };
  }
}

function parseTarget(value: unknown, caller: SessionCallerRef, host: string): SessionCallerRef {
  if (value === 'self') return caller;
  if (typeof value !== 'string' || value.length > 1024) throw new SessionCallError('invalid_request', 'Name a session as self or <hostId>/<providerId>/<nativeSessionId>.');
  const [hostId, providerId, ...rest] = value.split('/');
  const nativeSessionId = rest.join('/');
  if (!hostId || !providerId || !nativeSessionId) throw new SessionCallError('invalid_request', 'Name a session as self or <hostId>/<providerId>/<nativeSessionId>.');
  if (hostId !== host && hostId !== 'local') throw new SessionCallError('session_forbidden', 'Only sessions on this Host can be read.');
  return { providerId, nativeSessionId };
}

function historyQuery(request: Record<string, unknown>): AgentHistoryQuery {
  const query = optionalString(request.search, 'search', 200), turnId = optionalString(request.turnId, 'turnId', 4096);
  if (query !== undefined && turnId !== undefined) throw new SessionCallError('invalid_request', 'A search and a turn cannot be combined.');
  const cursor = optionalString(request.cursor, 'cursor', 16_384), limit = optionalInteger(request.limit, 'limit', 1, HISTORY_LIMIT);
  const textOffset = optionalInteger(request.textOffset, 'textOffset', 0, Number.MAX_SAFE_INTEGER);
  return { ...(cursor !== undefined ? { cursor } : {}), ...(query !== undefined ? { query } : {}), ...(turnId !== undefined ? { turnId } : {}),
    ...(limit !== undefined ? { limit } : {}), ...(textOffset !== undefined ? { textOffset } : {}) };
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > maximum) throw new SessionCallError('invalid_request', `Invalid ${field}.`);
  return value;
}
function optionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new SessionCallError('invalid_request', `${field} must be an integer from ${minimum} to ${maximum}.`);
  return value as number;
}
function encodeCursor(cursor: { offset: number; limit: number; providerId: string | null }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
function decodeCursor(value: unknown): { offset: number; limit: number; providerId: string | null } {
  try {
    const cursor = JSON.parse(Buffer.from(optionalString(value, 'cursor', 512)!, 'base64url').toString('utf8')) as { offset?: unknown; limit?: unknown; providerId?: unknown };
    if (Number.isSafeInteger(cursor.offset) && (cursor.offset as number) >= 0 && Number.isSafeInteger(cursor.limit)
      && (cursor.providerId === null || typeof cursor.providerId === 'string')) return cursor as { offset: number; limit: number; providerId: string | null };
  } catch { /* Reported below. */ }
  throw new SessionCallError('invalid_request', 'Invalid cursor.');
}

/** Serves session commands, one JSON request per connection, on a socket separate from local management. */
export async function listenSessionCalls(path: string, handle: (input: unknown) => Promise<Record<string, unknown>>): Promise<{ close(): Promise<void> }> {
  if (process.platform !== 'win32') await rm(path, { force: true });
  const server: Server = createServer({ allowHalfOpen: true }, (connection: Socket) => {
    let input = '', handled = false;
    const answer = () => {
      if (handled || connection.destroyed) return;
      handled = true;
      let request: unknown;
      try { request = JSON.parse(input); } catch { request = undefined; }
      void handle(request).then(response => connection.end(JSON.stringify(response)), () => connection.destroy());
    };
    connection.setEncoding('utf8');
    connection.setTimeout(30_000, () => connection.destroy());
    connection.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > REQUEST_BYTES) connection.destroy();
      else if (input.includes('\n')) answer();
    });
    connection.on('error', () => connection.destroy());
    connection.on('end', answer);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return { close: () => new Promise<void>(resolve => {
    server.close(() => resolve());
    if (process.platform !== 'win32') void rm(path, { force: true });
  }) };
}
