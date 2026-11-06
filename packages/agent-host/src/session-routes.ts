import type { AgentHistoryPage, AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { quotedSessionContextPrefix, type AgentInteractionRequest, type AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import { changeSessionRef, describeSessionRefs, SessionRefError, type SessionRefContext, type SessionRefs } from './session-refs.js';

/** A session on this Host, by provider and native identity. */
export interface SessionCallerRef { providerId: string; nativeSessionId: string }
export const refKey = (ref: SessionCallerRef) => JSON.stringify([ref.providerId, ref.nativeSessionId]);

/**
 * Who asks: the Host owner (the local management socket, or the owner through the Relay), or one of this Host's sessions
 * through its own credential. Every caller reaches every session of the owner's Hosts; share recipients' sessions are
 * neither visible nor reachable.
 */
export type SessionCaller = { kind: 'owner' } | { kind: 'session'; ref: SessionCallerRef };

/** Settings that decide what a session may do unattended; the website asks for a recent sign-in before changing them. */
export const PERMISSION_SETTINGS: readonly string[] = ['approval', 'sandbox', 'permissions'];

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

export interface SessionCreation {
  providerId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  planning?: boolean;
}
export interface SessionSetting { id: string; label: string; value: string | null; options?: Array<{ value: string; label: string }>; mutable?: boolean }
export interface SessionInspection { status: string; settings: SessionSetting[]; planning?: boolean; pendingInteractions: AgentInteractionRequest[] }
/** What the session commands do to sessions; each change runs once per operation identity. */
export interface SessionActions {
  create(input: SessionCreation, operationId: string): Promise<SessionCallerRef>;
  send(ref: SessionCallerRef, input: { text: string; steer?: boolean }, operationId: string): Promise<{ disposition?: string }>;
  cancel(ref: SessionCallerRef, operationId: string): Promise<void>;
  inspect(ref: SessionCallerRef): Promise<SessionInspection>;
  answer(ref: SessionCallerRef, requestId: string, response: AgentInteractionResponse, operationId: string): Promise<void>;
  setting(ref: SessionCallerRef, id: string, value: string, operationId: string): Promise<void>;
  planning(ref: SessionCallerRef, active: boolean, operationId: string): Promise<void>;
  rename(ref: SessionCallerRef, title: string): Promise<string>;
  /** Lets the Controller close the session's native process; false while something still needs it. */
  release(ref: SessionCallerRef): Promise<boolean>;
}

export interface SessionRouteContext {
  hostId(): Promise<string | undefined>;
  catalog: SessionCallerCatalog;
  refs?: SessionRefContext;
  actions?: SessionActions;
  isShared(ref: SessionCallerRef): boolean;
  /** The website's origin, where a session's link opens it; undefined before the Host is paired. */
  siteOrigin?(): string | undefined;
  /** Sends a request naming another Host there, through the Relay; without it only this Host is reachable. */
  forward?(hostId: string, request: Record<string, unknown>): Promise<SessionCallResult>;
}

export type SessionCallResult = { result: Record<string, unknown> } | { error: { code: string; message: string } };
export class SessionCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const LIST_LIMIT = 50;
const HISTORY_LIMIT = 10;
const TEXT_LIMIT = 256 * 1024;
const CONTEXT_ENTRIES = 200;

function fail(code: string, message: string): never { throw new SessionCallError(code, message); }

/** Answers one session command. The request's fields are the command line's options; the caller is already known. */
export async function handleSessionRequest(input: unknown, caller: SessionCaller, context: SessionRouteContext): Promise<SessionCallResult> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'The session command is invalid.');
    const request = input as Record<string, unknown>;
    // Until the Relay registers the Host, its sessions are addressed as local.
    const host = await context.hostId() ?? 'local';
    const here = (hostId: string) => hostId === host || hostId === 'local';
    const address = (ref: SessionCallerRef) => `${host}/${ref.providerId}/${ref.nativeSessionId}`;
    const callerRef = caller.kind === 'session' ? caller.ref : undefined;
    const self = (ref: SessionCallerRef) => callerRef && refKey(ref) === refKey(callerRef) ? { self: true } : {};
    const state = (ref: SessionCallerRef, summary?: RemoteSessionSummary): SessionCallerState => context.catalog.liveState(ref)
      ?? (summary?.state === 'unavailable' ? 'failed' : summary?.state ?? 'unknown');
    const described = (refs: SessionRefs) => ({
      refs: refs.refs.map(ref => ({ address: address(ref), providerId: ref.providerId, ...(ref.title ? { title: ref.title } : {}), origin: ref.origin, ...(ref.addedAt ? { addedAt: ref.addedAt } : {}) })),
      referencedBy: refs.referencedBy.filter(ref => !context.isShared(ref)).map(ref => ({ address: address(ref), providerId: ref.providerId, ...(ref.title ? { title: ref.title } : {}), origin: ref.origin })),
    });
    /** A session's references, like its title, belong to its description; a Host that cannot tell lists none. */
    const refsOf = async (ref: SessionCallerRef) => context.refs ? described(await describeSessionRefs(ref, context.refs).catch(() => ({ revision: 0, refs: [], referencedBy: [] })))
      : { refs: [], referencedBy: [] };
    const withRefs = (refs: Awaited<ReturnType<typeof refsOf>>) => ({ ...(refs.refs.length ? { refs: refs.refs } : {}), ...(refs.referencedBy.length ? { referencedBy: refs.referencedBy } : {}) });
    /** A session named by the request: on this Host, or the request goes to the Host that has it. */
    const target = (value: unknown, field = 'target'): SessionCallerRef | { hostId: string } => {
      if (value === 'self') return callerRef ?? fail('invalid_request', 'Only a session can name itself; name a session as <hostId>/<providerId>/<nativeSessionId>.');
      if (typeof value !== 'string' || value.length > 1024) fail('invalid_request', `Name the ${field} as self or <hostId>/<providerId>/<nativeSessionId>.`);
      const [hostId, providerId, ...rest] = value.split('/');
      const nativeSessionId = rest.join('/');
      if (!hostId || !providerId || !nativeSessionId) fail('invalid_request', `Name the ${field} as self or <hostId>/<providerId>/<nativeSessionId>.`);
      if (!here(hostId)) return { hostId };
      const ref = { providerId, nativeSessionId };
      if (context.isShared(ref)) fail('session_not_found', 'No such session on this Host.');
      return ref;
    };
    const local = (value: unknown, field?: string): SessionCallerRef => {
      const ref = target(value, field);
      if ('hostId' in ref) fail('invalid_request', `The ${field ?? 'target'} must be on the same Host as the session it belongs to.`);
      return ref;
    };
    const elsewhere = async (hostId: string): Promise<SessionCallResult> => {
      if (!context.forward) fail('host_unreachable', 'Sessions on other Hosts are reachable through the Relay only.');
      // The other Host answers the owner, so self becomes the calling session's address.
      const named = (value: unknown) => value === 'self' && callerRef ? address(callerRef) : value;
      return context.forward(hostId, { ...request, ...(request.from !== undefined ? { from: named(request.from) } : {}),
        ...(Array.isArray(request.refs) ? { refs: request.refs.map(named) } : {}) });
    };
    const actions = () => context.actions ?? fail('unsupported_configuration', 'This Controller cannot change sessions.');
    const operation = () => {
      const value = request.operationId;
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('invalid_request', 'An operation identity is required.');
      return value;
    };
    const exists = async (ref: SessionCallerRef) => {
      const summary = await context.catalog.session(ref);
      if (!summary && !self(ref).self) fail('session_not_found', 'No such session on this Host.');
      return summary;
    };

    switch (request.command) {
      case 'list': {
        if (typeof request.host === 'string' && !here(request.host)) return await elsewhere(request.host);
        const providerId = optionalString(request.providerId, 'providerId', 64);
        const limit = optionalInteger(request.limit, 'limit', 1, LIST_LIMIT) ?? 20;
        let offset = 0;
        if (request.cursor !== undefined) {
          const cursor = decodeCursor(request.cursor);
          if (cursor.limit !== limit || cursor.providerId !== (providerId ?? null)) fail('invalid_request', 'The cursor belongs to another listing.');
          offset = cursor.offset;
        }
        const providers = context.catalog.providers();
        if (providerId !== undefined && !providers.includes(providerId)) fail('invalid_request', 'The provider is unavailable on this Host.');
        const unavailable: string[] = [];
        const listed = await Promise.all((providerId === undefined ? providers : [providerId]).map(id => context.catalog.sessions(id)
          .catch(() => { unavailable.push(id); return []; })));
        const summaries = listed.flat().filter(summary => !context.isShared(summary))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || refKey(left).localeCompare(refKey(right)));
        const page = summaries.slice(offset, offset + limit);
        const pageRefs = await Promise.all(page.map(summary => refsOf(summary)));
        return { result: {
          sessions: page.map((summary, index) => ({ address: address(summary), providerId: summary.providerId, title: summary.title,
            ...(summary.workspace ? { cwd: summary.workspace } : {}), updatedAt: summary.updatedAt, state: state(summary, summary), ...self(summary), ...withRefs(pageRefs[index]!) })),
          ...(offset + limit < summaries.length ? { nextCursor: encodeCursor({ offset: offset + limit, limit, providerId: providerId ?? null }) } : {}),
          ...(unavailable.length ? { unavailableProviders: unavailable.sort() } : {}),
        } };
      }
      case 'read': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        // A limit of 0 describes the session without reading its history.
        const describeOnly = request.limit === 0;
        const query = historyQuery(describeOnly ? { ...request, limit: undefined } : request);
        const summary = await exists(ref);
        let page: AgentHistoryPage = { entries: [] };
        if (!describeOnly) try { page = await context.catalog.history(ref, query); }
        catch (error) {
          if ((error as { code?: unknown }).code === 'native_session_unavailable') fail('session_not_found', 'No such session on this Host.');
          fail('history_unavailable', 'The session history could not be read.');
        }
        return { result: {
          session: { address: address(ref), providerId: ref.providerId, ...(summary ? { title: summary.title } : {}),
            ...(summary?.workspace ? { cwd: summary.workspace } : {}), ...(summary?.model ? { model: summary.model } : {}), state: state(ref, summary), ...self(ref), ...withRefs(await refsOf(ref)) },
          entries: page.entries, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        } };
      }
      case 'create': {
        if (typeof request.host === 'string' && !here(request.host)) return await elsewhere(request.host);
        const providerId = optionalString(request.providerId, 'providerId', 64) ?? fail('invalid_request', 'Name the provider to create the session with.');
        if (!context.catalog.providers().includes(providerId)) fail('invalid_request', 'The provider is unavailable on this Host.');
        const from = request.from === undefined ? undefined : local(request.from, 'session it is opened from');
        const refs = optionalAddresses(request.refs).map(value => local(value, 'referenced session'));
        if (request.context !== undefined && (request.context !== true || !from)) fail('invalid_request', 'Copying context needs the session it is opened from.');
        const message = optionalText(request.message, 'message');
        for (const ref of [...(from ? [from] : []), ...refs]) await exists(ref);
        const operationId = operation();
        const created = await actions().create({ providerId, ...pick(request, ['cwd', 'model', 'reasoningEffort'], 4096),
          ...(typeof request.planning === 'boolean' ? { planning: request.planning } : {}) }, operationId);
        if (context.refs) {
          // The agent hears about its source and references with its first input.
          if (from) await context.refs.store.setSource(created, from, { tell: true });
          for (const ref of refs) await changeSessionRef(created, 'add', ref, context.refs);
        }
        let text = message;
        if (request.context === true && from) text = await contextPrefix(context, from, address(from)) + (text ?? '');
        const sent = text ? await actions().send(created, { text }, `${operationId}:message`) : undefined;
        return { result: { session: { address: address(created), providerId, ...withRefs(await refsOf(created)) }, ...(sent ? { message: sent } : {}) } };
      }
      case 'send': case 'steer': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        const text = optionalText(request.text, 'text') ?? fail('invalid_request', 'Give the text to send.');
        await exists(ref);
        return { result: await actions().send(ref, { text, ...(request.command === 'steer' ? { steer: true } : {}) }, operation()) };
      }
      case 'cancel': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        await exists(ref);
        await actions().cancel(ref, operation());
        return { result: { canceled: true } };
      }
      case 'link': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        await exists(ref);
        const site = context.siteOrigin?.() ?? fail('host_unregistered', 'This Host is not paired with a Relay, so its sessions have no link.');
        const hostId = await context.hostId() ?? fail('host_unregistered', 'This Host is not registered with the Relay yet.');
        return { result: { session: { address: address(ref) }, url: site + controllerPath({ hostId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }) } };
      }
      case 'inspect': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        await exists(ref);
        return { result: { session: { address: address(ref), ...self(ref) }, ...await actions().inspect(ref) } };
      }
      case 'answer': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        // A session approving its own request would grant itself what its user did not.
        if (self(ref).self) fail('session_forbidden', 'A session cannot answer its own requests.');
        const requestId = optionalString(request.requestId, 'requestId', 512) ?? fail('invalid_request', 'Name the request to answer.');
        if (!request.response || typeof request.response !== 'object' || Array.isArray(request.response)) fail('invalid_request', 'Give the response as JSON.');
        await exists(ref);
        await actions().answer(ref, requestId, request.response as AgentInteractionResponse, operation());
        return { result: { answered: requestId } };
      }
      case 'set': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        await exists(ref);
        const settings = request.settings === undefined ? {} : request.settings;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.values(settings).some(value => typeof value !== 'string')) fail('invalid_request', 'Settings are id=value pairs.');
        const title = optionalString(request.title, 'title', 512);
        if (!Object.keys(settings).length && title === undefined && typeof request.planning !== 'boolean') fail('invalid_request', 'Give a setting, planning or a title to change.');
        // Like answering its own requests, loosening its own permissions would grant a session what its user did not.
        if (self(ref).self && Object.keys(settings).some(id => PERMISSION_SETTINGS.includes(id))) fail('session_forbidden', 'A session cannot change its own permission settings.');
        const operationId = operation();
        for (const [id, value] of Object.entries(settings as Record<string, string>)) await actions().setting(ref, id, value, `${operationId}:${id}`);
        if (typeof request.planning === 'boolean') await actions().planning(ref, request.planning, `${operationId}:planning`);
        const renamed = title === undefined ? undefined : await actions().rename(ref, title);
        return { result: { session: { address: address(ref), ...(renamed !== undefined ? { title: renamed } : {}) } } };
      }
      case 'release': {
        const ref = target(request.target);
        if ('hostId' in ref) return await elsewhere(ref.hostId);
        await exists(ref);
        return { result: { released: await actions().release(ref) } };
      }
      case 'ref': {
        if (!context.refs) fail('unsupported_configuration', 'Session references are unavailable on this Controller.');
        const holder = target(request.session ?? 'self', 'session');
        if ('hostId' in holder) return await elsewhere(holder.hostId);
        if (request.action === 'list') return { result: described(await describeSessionRefs(holder, context.refs)) };
        if (request.action !== 'add' && request.action !== 'remove') fail('invalid_request', 'Use session ref list, add or remove.');
        const ref = local(request.target, 'referenced session');
        try { return { result: described(await changeSessionRef(holder, request.action, ref, context.refs)) }; }
        catch (error) {
          if (error instanceof SessionRefError) fail(error.code, error.message);
          throw error;
        }
      }
      default: fail('invalid_request', 'Unknown session command.');
    }
  } catch (error) {
    if (error instanceof SessionCallError) return { error: { code: error.code, message: error.message } };
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code === 'operation_outcome_unknown') return { error: { code: 'outcome_unknown', message: 'The change may or may not have happened. Inspect the session before trying again.' } };
    return { error: { code: code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'command_failed', message: error instanceof Error ? error.message : 'The Controller could not answer the session command.' } };
  }
}

/** The source's recent conversation, quoted into the first message of a session opened from it with its context. */
async function contextPrefix(context: SessionRouteContext, from: SessionCallerRef, sourceAddress: string): Promise<string> {
  const entries: AgentHistoryPage['entries'] = [];
  let cursor: string | undefined;
  do {
    const page = await context.catalog.history(from, { limit: HISTORY_LIMIT, ...(cursor ? { cursor } : {}) });
    entries.push(...page.entries.filter(entry => entry.role === 'user' || entry.role === 'assistant'));
    cursor = page.nextCursor;
  } while (cursor && entries.length < CONTEXT_ENTRIES);
  const history = entries.slice(0, CONTEXT_ENTRIES).reverse().map(entry => ({ role: entry.role, text: entry.text }));
  return quotedSessionContextPrefix({ id: `fork-${Date.now().toString(36)}`, sourceSession: sourceAddress, capturedAt: new Date().toISOString(), text: JSON.stringify(history) });
}

function pick(request: Record<string, unknown>, fields: readonly string[], maximum: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) { const value = optionalString(request[field], field, maximum); if (value !== undefined) result[field] = value; }
  return result;
}
function optionalAddresses(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string')) fail('invalid_request', 'References are session addresses.');
  return value as string[];
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > TEXT_LIMIT) fail('invalid_request', `The ${field} must be text of at most ${TEXT_LIMIT} characters.`);
  return value;
}
function historyQuery(request: Record<string, unknown>): AgentHistoryQuery {
  const query = optionalString(request.search, 'search', 200), turnId = optionalString(request.turnId, 'turnId', 4096);
  if (query !== undefined && turnId !== undefined) fail('invalid_request', 'A search and a turn cannot be combined.');
  const cursor = optionalString(request.cursor, 'cursor', 16_384), limit = optionalInteger(request.limit, 'limit', 1, HISTORY_LIMIT);
  const textOffset = optionalInteger(request.textOffset, 'textOffset', 0, Number.MAX_SAFE_INTEGER);
  return { ...(cursor !== undefined ? { cursor } : {}), ...(query !== undefined ? { query } : {}), ...(turnId !== undefined ? { turnId } : {}),
    ...(limit !== undefined ? { limit } : {}), ...(textOffset !== undefined ? { textOffset } : {}) };
}
function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > maximum) fail('invalid_request', `Invalid ${field}.`);
  return value;
}
function optionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail('invalid_request', `${field} must be an integer from ${minimum} to ${maximum}.`);
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
  fail('invalid_request', 'Invalid cursor.');
}
