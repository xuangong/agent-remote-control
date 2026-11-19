import { randomUUID } from 'node:crypto';
import { bindAgentSessionTools, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { SessionWireAgent, SessionWireOperation } from '@orchardworks/agent-session-runtime';

import { operationUuid } from '../operation-uuid.js';
import { handleRoleRequest } from '../role-routes.js';
import { handleSessionRequest, type SessionActions, type SessionCaller, type SessionCallerRef, type SessionCallResult } from '../session-routes.js';
import type { SessionRefContext } from '../session-refs.js';
import type { SessionCoreContext } from './context.js';
import type { AgentHostRuntimeOptions } from './types.js';

/**
 * Session commands: the commands a session's shell, the website and this computer's command line run against sessions and roles.
 *
 * Contract.
 * - Every change a command makes runs like the website's: through the operation cache, once per operation identity, on a session held for the
 *   duration of the change (`holding`). A command line's operation identity is a UUID, derived when the caller chose another form.
 * - `callSession` answers one session command with the Host's id, its catalog, references, actions and sharing; `forward` reaches other Hosts for
 *   commands that came from this Host's own sockets. `callRole` answers a role command with the tools of the role a session holds, or its worker tools.
 * - `sessionRefs` is the context of session references (the sessions a session refers to, read from the directories and catalogs); absent
 *   without a reference store.
 */
export function createSessionCommands(ctx: SessionCoreContext, options: AgentHostRuntimeOptions) {
  /** A command line's operation identity as the operation cache takes it: a UUID, derived when the caller chose another form. */
  const cliOperation = operationUuid;
  async function holding<T>(ref: SessionCallerRef, work: (agent: SessionWireAgent) => Promise<T>): Promise<T> {
    const held = await ctx.automationAccess.acquire(ref.providerId, ref.nativeSessionId);
    try { return await work(held.agent); } finally { held.release(); }
  }
  const cliExecute = (agent: SessionWireAgent, operationId: string, kind: SessionWireOperation['kind'], parameters: unknown, dispatch: () => Promise<unknown>, validate?: () => Promise<void> | void) =>
    ctx.relay.executeOperation('host:cli')(agent, { operationId: cliOperation(operationId), kind, parameters, maximumResultBytes: 1024 }, { dispatch, ...(validate ? { validate } : {}) });
  /** The session commands' changes, run like the website's: through the operation cache, once per operation identity. */
  const sessionActions: SessionActions = {
    async create(input, operationId) {
      const result = await ctx.create({ requestId: randomUUID(), method: 'POST', path: '/remote/create', sessionId: randomUUID(), operationScope: 'host:cli',
        body: JSON.stringify({ ...input, operationId: cliOperation(operationId) }) }, { ...input, operationId: cliOperation(operationId) });
      const created = JSON.parse(result.body) as { nativeSessionId?: string };
      if (result.status >= 400 || !created.nativeSessionId) throw new Error('The session could not be created.');
      return { providerId: input.providerId, nativeSessionId: created.nativeSessionId };
    },
    send: (ref, input, operationId) => holding(ref, async agent => {
      if (input.steer && !agent.steer) throw Object.assign(new Error('This session cannot be steered.'), { code: 'unsupported_configuration' });
      const result = await cliExecute(agent, operationId, input.steer ? 'steer' : 'send_message', input.steer ? { text: input.text } : { text: input.text, delivery: null }, async () => {
        const acceptance = input.steer ? await agent.steer!(input.text) : await agent.sendMessage(input.text);
        return acceptance ? { disposition: acceptance.disposition } : {};
      }) as { disposition?: string };
      return result;
    }),
    cancel: (ref, operationId) => holding(ref, async agent => {
      if (!agent.cancel) throw Object.assign(new Error('This session cannot be canceled.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'cancel', {}, async () => { await agent.cancel!(); return { accepted: true }; });
    }),
    inspect: ref => holding(ref, async agent => {
      const payload = agent.snapshot().payload;
      return { status: payload.status, ...(payload.runtimeInfo.planning ? { planning: payload.runtimeInfo.planning.active } : {}),
        settings: (payload.runtimeInfo.settings ?? []).map(setting => ({ id: setting.id, label: setting.label, value: setting.value, ...(setting.mutable !== undefined ? { mutable: setting.mutable } : {}),
          ...(setting.options ? { options: setting.options.map(option => ({ value: option.value, label: option.label })) } : {}) })),
        pendingInteractions: payload.pendingInteractions };
    }),
    answer: (ref, requestId, response, operationId) => holding(ref, async agent => {
      await cliExecute(agent, operationId, 'interaction_response', { requestId, response }, async () => { await agent.respondToInteraction(requestId, response); return { accepted: true }; },
        agent.validateInteractionResponse ? () => agent.validateInteractionResponse!(requestId, response) : undefined);
    }),
    setting: (ref, id, value, operationId) => holding(ref, async agent => {
      if (!agent.setSessionSetting) throw Object.assign(new Error('This session has no settings to change.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'set_session_setting', { settingId: id, value }, async () => { await agent.setSessionSetting!(id, value); return { accepted: true }; });
    }),
    planning: (ref, active, operationId) => holding(ref, async agent => {
      if (!agent.setPlanning) throw Object.assign(new Error('This session has no planning mode.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'set_planning', { active }, async () => { await agent.setPlanning!(active); return { accepted: true }; });
    }),
    async rename(ref, title, operationId) {
      const result = await ctx.controlRequest({ requestId: randomUUID(), method: 'POST', path: '/remote/session/rename', operationScope: 'host:cli',
        body: JSON.stringify({ ...ref, title, operationId: cliOperation(operationId) }) });
      const renamed = JSON.parse(result.body) as { title?: string; error?: string; code?: string };
      if (result.status >= 400 || typeof renamed.title !== 'string') throw Object.assign(new Error(renamed.error ?? 'The session could not be renamed.'), { code: renamed.code ?? 'rename_failed' });
      return renamed.title;
    },
    async release(ref) {
      const binding = ctx.bindings.getByNative(ref.providerId, ref.nativeSessionId), agent = binding && ctx.liveAgent(binding.agentId);
      if (!binding || !agent) return true;
      if (ctx.idle.hasDemand(binding.agentId) || !ctx.providers.require(ref.providerId).directory.canReleaseSession?.(ref.nativeSessionId) || !agent.canReleaseIdle()) return false;
      await ctx.terminalRefresh.releaseJournal(binding);
      await ctx.relay.closeAgent(binding.agentId);
      await ctx.providers.require(ref.providerId).directory.sessionReleased?.(ref.nativeSessionId);
      return true;
    },
  };
  /** One session command; forward reaches other Hosts, for commands that came from this Host's own sockets. */
  /** The tools of the role a session holds, or its worker tools, which role commands run from its shell. */
  async function roleTools(ref: SessionCallerRef): Promise<readonly AgentSessionTool[]> {
    const holder = ctx.nativeRef(ref);
    const extensions = await ctx.roles.extensions(ctx.genericSuccessionSource(holder) ?? holder, () => holder);
    const worker = !extensions && ctx.workerSupport?.enabled(holder) ? [ctx.workerSupport.namespace(() => holder, false)] : [];
    return bindAgentSessionTools([...(extensions?.tools ?? []), ...[...(extensions?.toolNamespaces ?? []), ...worker].flatMap(namespace => namespace.tools)]);
  }
  function callRole(request: unknown, caller: SessionCaller): Promise<SessionCallResult> {
    return handleRoleRequest(request, caller, session => roleTools(session.ref));
  }
  function callSession(request: unknown, caller: SessionCaller, forward?: (hostId: string, request: Record<string, unknown>) => Promise<SessionCallResult>): Promise<SessionCallResult> {
    return handleSessionRequest(request, caller, { hostId: async () => ctx.options.hostId?.(), catalog: ctx.sessionCatalog, ...(sessionRefs ? { refs: sessionRefs } : {}), actions: sessionActions,
      isShared: ref => ctx.options.sessionCallers?.store.isShared(ref) ?? false, siteOrigin: () => ctx.options.siteOrigin?.(), ...(forward ? { forward } : {}) });
  }
  const sessionRefs: SessionRefContext | undefined = options.sessionRefs ? {
    store: options.sessionRefs,
    hostId: async () => options.hostId?.(),
    async grantedSource(holder) {
      if (options.providerEnabled?.(holder.providerId) === false) return undefined;
      return ctx.providers.get(holder.providerId)?.directory.sourceReference?.(holder.nativeSessionId);
    },
    async setGrantRemoved(holder, removed) {
      const directory = ctx.providers.get(holder.providerId)?.directory;
      if (!await directory?.sourceReference?.(holder.nativeSessionId).catch(() => undefined)) return;
      await directory!.setSourceReferenceRemoved?.(holder.nativeSessionId, removed);
    },
    async title(target) {
      if (options.providerEnabled?.(target.providerId) === false) return undefined;
      const summary = await ctx.providers.catalog(target.providerId)?.session(target.nativeSessionId);
      return summary ? summary.title ?? '' : undefined;
    },
  } : undefined;
  return { callSession, callRole, sessionRefs };
}
