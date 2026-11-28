import { createHash, randomUUID } from 'node:crypto';
import { isTeamSeat, isSuccessionRequest, isNativeSessionRef, nativeSessionRefKey, type TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { AgentOperationRejectedError, AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { OperationCacheError, UnsupportedAgentCapabilityError, type AgentRemoteHttpResult, type RemoteHostControlRequest } from '@orchardworks/agent-session-runtime';

import { directoryNativeEffect } from '../directory-mutation.js';
import { allowedWorkspace, HostExecutionPolicyError } from '../execution-policy.js';
import { createNativeStartBackoff, nativeStartTarget } from '../native-start-backoff.js';
import { SuccessionPreparationRejected } from '../local-succession-preparation.js';
import { SOURCE_WITNESS_RESULT_BYTES, validSourceWitnessIdentity } from '../session-succession-store.js';
import { jsonBytes } from '../succession-persistence.js';
import { changeSessionRef, describeSessionRefs, SessionRefError, validTarget } from '../session-refs.js';
import { browseWorkspaceFolders, createWorkspaceFolder } from '../workspace-folders.js';
import type { AgentHostRequestDiagnostic } from './types.js';
import type { SessionCoreContext } from './context.js';
import { boundedSourceIdentity, failureResponse, HostRequestError, json, parseAttachRequest, parseBody, parseCreateRequest, parseRenameRequest, parseStopRequest, publicBinding, requestOperation, requiredString } from './requests.js';

/**
 * Control routes: the Host's control requests (`/remote/...`) as the Relay and this computer's command line send them.
 *
 * Contract.
 * - `control` answers every request: it records a start and a completed diagnostic (never failing the request for it), repeats a recent native
 *   start failure instead of starting the session again until its backoff expires (an explicit takeover always tries), and adds the request identity to
 *   an error answer. Request parsing and failure answers are `requests.ts`.
 * - `controlRequest` refuses while the Controller is closed, and refuses mutations while it drains. Then it routes by path: Host status, succession,
 *   Team, catalog and workspace reads, session references, rename, folder creation, stop, create and attach. A route reads only what its
 *   parser accepted.
 * - `create` runs through the operation cache once per operation identity, with the succession admission of the source it reads; `cancelAgent` bounds a native cancel
 *   by the cancel deadline and reports cancelled, unsupported or failed.
 *
 * The routes own no state of their own except the start backoff and the causes of generic failures; everything else is read through the context.
 */
export function createControlRoutes(ctx: SessionCoreContext) {
  const operationScope = (request: RemoteHostControlRequest): string => request.operationScope ?? 'local';
  async function create(request: RemoteHostControlRequest, payload: Record<string, unknown>, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    const { authorizeSuccessionRead, sessions, enrollment, markShared, mutationFamily, nativeRef, operationCache, options, project, providers, sessionRefs, successionBoundary, tracked, workerExtensions } = ctx;
    const { providerId, operationId, proposedAgentId, editing, provenance, settings } = parseCreateRequest(request, payload);
    const source = provenance ? nativeRef(provenance) : undefined;
    const targets = source ? mutationFamily([source]) : [];
    const selected = providers.require(providerId), directory = selected.directory;
    const scope = operationScope(request);
    const qualified = (context?.successionEnrollmentVersion ?? 0) >= 2 && !!settings.sourceNativeSessionId && !!enrollment;
    const sourceReader = settings.sourceNativeSessionId ? nativeRef({ providerId, nativeSessionId: settings.sourceNativeSessionId }) : undefined;
    // An exact durable source result is forward recovery, including after cache expiry/restart.
    const savedCreation = sourceReader && enrollment ? await enrollment.sourceResult(scope, operationId, sourceReader, settings, directory) : undefined;
    // A pending witness is uncertainty, even if a producer certificate later disappears.
    if (qualified && !savedCreation) enrollment!.assertSourceCreateAvailable(scope, operationId, sourceReader!, settings);
    const maximumResultBytes = savedCreation ? Math.max(1, jsonBytes(savedCreation.reader.nativeSessionId)) : qualified ? SOURCE_WITNESS_RESULT_BYTES : 1024;
    const nativeSessionId = await operationCache.execute<string>({
      operationId,
      scope,
      kind: 'create_agent',
      target: providerId,
      parameters: { ...settings, ...(source ? { creationSource: source } : {}) },
    }, {
      mutationTargets: targets.map(nativeSessionRefKey),
      admit: entry => savedCreation ? undefined : successionBoundary?.admit(targets, entry.key),
      run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId, kind: 'execute_command', parameters: {}, maximumResultBytes }, scope, work, entry) : work(),
      validate: async () => {
        if (source) await authorizeSuccessionRead(source, source);
        if (editing && !directory.supportsPromptEditing) throw new HostRequestError(400, 'unsupported_configuration', 'Prompt editing is unavailable on this Host/provider. Update the Controller.');
        if (settings.sourceNativeSessionId && !directory.supportsSourceReferences) throw new HostRequestError(400, 'unsupported_configuration', 'This Host/provider does not support source-session tools. Update the Host or use /fork.');
        if (options.executionPolicy) {
          const selected = payload.workspaceId === undefined ? undefined
            : (await directory.workspaces()).find(workspace => workspace.id === payload.workspaceId);
          if (payload.workspaceId !== undefined && !selected) throw new HostExecutionPolicyError('Unknown local Host workspace.');
          await allowedWorkspace(options.executionPolicy, typeof payload.cwd === 'string' ? payload.cwd : selected?.path ?? options.executionPolicy.defaultWorkspace);
        }
        if (editing) {
          try { await directory.validatePromptEdit?.({ nativeSessionId: settings.editNativeSessionId!, turnId: settings.editTurnId!, messageId: settings.editMessageId! }); }
          catch (error) {
            if (error instanceof HostExecutionPolicyError || error instanceof AgentRuntimeError) throw error;
            throw new OperationCacheError('operation_rejected', error instanceof Error ? error.message : 'The selected prompt could not be verified.');
          }
        }
        if (sessions.isReserved(proposedAgentId)) {
          throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already reserved.');
        }
        if (qualified && !savedCreation) {
          if (!validSourceWitnessIdentity(scope, operationId) || !boundedSourceIdentity(proposedAgentId) || !isNativeSessionRef(sourceReader)) throw new HostRequestError(400, 'invalid_request', 'Qualified source witness and proposed Agent identities must fit their reviewed bounds.');
          if (await directory.supportsBoundedSourceCreate?.(settings) !== true) throw new HostRequestError(400, 'unsupported_configuration', 'This directory create mode has not certified bounded source results.');
        }
      },
      beforeDispatch: () => { if (!savedCreation) successionBoundary?.recheck(targets); },
      dispatch: entry => {
        if (savedCreation) return Promise.resolve(savedCreation.reader.nativeSessionId);
        // A new conversation gets the worker tools its provider must declare at creation; Sides and prompt edits do not.
        let created: string | undefined;
        const worker = editing || settings.sourceNativeSessionId ? undefined : workerExtensions(providerId, undefined, () => created ? nativeRef({ providerId, nativeSessionId: created }) : undefined);
        const create = () => directoryNativeEffect(entry, targets.map(nativeSessionRefKey), async evidence => { created = await directory.create({ ...settings, ...worker, ...(payload.shared === true ? { yolo: false } : {}) }, evidence); return created; });
        const work = () => settings.sourceNativeSessionId && enrollment
          ? enrollment.sourceMutation(scope, operationId, sourceReader!, settings, create,
            async id => (await directory.sourceReferences?.())?.some(grant => grant.nativeSessionId === id && grant.sourceNativeSessionId === settings.sourceNativeSessionId) === true, qualified, directory) : create();
        return work();
      },
      maximumResultBytes,
    });
    await markShared(payload, providerId, nativeSessionId);
    // A Side's agent learns its source from the instructions it is created with.
    if (settings.sourceNativeSessionId) await sessionRefs?.store.setSource({ providerId, nativeSessionId }, { providerId, nativeSessionId: settings.sourceNativeSessionId }, { tell: false }).catch(() => undefined);
    return json(200, publicBinding(await tracked(project(providerId, proposedAgentId, nativeSessionId, undefined, undefined, false, undefined, qualified && !savedCreation))));
  }
  const nativeStarts = createNativeStartBackoff();
  // Generic failure responses do not describe their cause; the Controller log records its class and code.
  const failureCauses = new WeakMap<AgentRemoteHttpResult, string>();
  async function control(request: RemoteHostControlRequest, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    const { options } = ctx;
    const requestId = request.requestId && /^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) ? request.requestId : randomUUID();
    const operation = requestOperation(request);
    const started = Date.now();
    const start = nativeStartTarget(request.path, request.method, request.body);
    const diagnostic = (event: AgentHostRequestDiagnostic['event'], status?: number, code?: string, detail: Pick<AgentHostRequestDiagnostic, 'backoff' | 'cause'> = {}) => {
      try { options.onRequestDiagnostic?.({ event, requestId, operation, elapsedMs: Date.now() - started,
        ...(status === undefined ? {} : { status }), ...(code ? { code } : {}),
        ...(start ? { providerId: start.providerId, sessionRef: createHash('sha256').update(start.nativeSessionId).digest('hex').slice(0, 16) } : {}),
        ...detail }); } catch { /* Diagnostics cannot change request outcomes. */ }
    };
    diagnostic('host_request_started');
    const backedOff = start && nativeStarts.blocked(start);
    const result = backedOff || await controlRequest(request, context);
    if (start && !backedOff) nativeStarts.settle(start, result);
    const data = result.status >= 400 ? JSON.parse(result.body) : {};
    const cause = failureCauses.get(result);
    diagnostic('host_request_completed', result.status, typeof data.code === 'string' ? data.code : undefined,
      { ...(backedOff ? { backoff: true as const } : {}), ...(cause ? { cause } : {}) });
    return result.status >= 400 ? { ...result, body: JSON.stringify({ ...data, requestId }) } : result;
  }
  async function controlRequest(request: RemoteHostControlRequest, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    const { admission, authorizeSuccessionRead, sessions, callSession, directoryOperation, enrollment, hostStatus, liveAgent, markShared, mutationFamily, nativeRef, operationCache, options, project, providers, sessionRefs, succession, successionBoundary, successionReady, successionService, team, tracked } = ctx;
    try {
      await successionReady;
      const refusal = admission.refuse(request.method);
      if (refusal) throw new HostRequestError(503, refusal.code, refusal.message);
      const url = new URL(request.path, 'http://agent-host.local');
      const payload = request.method === 'POST' ? parseBody(request.body) : undefined;
      if (request.method === 'GET' && url.pathname === '/remote/host-status') return json(200, await hostStatus.read());
      if (url.pathname === '/remote/succession/enrollment' || options.succession?.enrollment && url.pathname.startsWith('/remote/succession') && request.method === 'POST') return json(403, { code: 'succession_authority_required', error: 'Use the authenticated Relay association reservation.' });
      if (url.pathname.startsWith('/remote/succession')) {
        if (!successionService || !succession) return json(404, { code: 'succession_unavailable', error: 'Session succession is unavailable.' });
        try {
          if (request.method === 'GET' && url.pathname === '/remote/succession/status') {
            const record = succession.coordinator.status(requiredString(url.searchParams.get('operationId'), 'operationId'));
            await authorizeSuccessionRead(record.from, record.to ?? record.from);
            return json(200, record);
          }
          if (request.method === 'POST' && url.pathname === '/remote/succession/prepare' && isSuccessionRequest(payload)) {
            await authorizeSuccessionRead(payload.from, payload.from);
            return json(200, await successionService.prepare(payload));
          }
          if (request.method === 'POST' && payload && ['commit', 'cancel', 'reconcile'].some(action => url.pathname === `/remote/succession/${action}`)) {
            const operationId = requiredString(payload.operationId, 'operationId');
            const record = succession.coordinator.status(operationId);
            await authorizeSuccessionRead(record.from, record.to ?? record.from);
            if (succession.store.read(record.roleId).associationAuthority) throw new Error('An authenticated association reservation is required.');
            if (url.pathname.endsWith('/commit')) {
              if (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 1) throw new Error('A valid expected revision is required.');
              return json(200, await successionService.commit(operationId, payload.expectedRevision as number));
            }
            if (url.pathname.endsWith('/cancel')) return json(200, await succession.coordinator.cancel(operationId));
            if (record.phase === 'committed') return json(200, { materialized: await successionService.reconcileFirstInput(operationId) });
            return json(200, await succession.coordinator.reconcileReady(operationId));
          }
          return json(400, { code: 'invalid_succession_request', error: 'Invalid session succession request.' });
        } catch (error) {
          if (error instanceof HostExecutionPolicyError) throw error;
          return json(409, { code: error instanceof SuccessionPreparationRejected ? error.code : 'succession_request_failed', error: error instanceof Error ? error.message : 'Session succession failed.' });
        }
      }
      if (url.pathname === '/remote/team/session-models') {
        if (!team) return json(404, {error: 'Update the Controller to use Teams.'});
        if (request.method !== 'GET') return json(405, {error: 'Method is not allowed.'});
        try { return json(200, { models: await team.sessionModels({ providerId: requiredString(url.searchParams.get('providerId'), 'providerId'), nativeSessionId: requiredString(url.searchParams.get('nativeSessionId'), 'nativeSessionId') }) ?? [] }); }
        catch (error) { return json(409, {error: error instanceof Error ? error.message : 'Models are unavailable.'}); }
      }
      if (url.pathname === '/remote/team/create-seat') {
        if (!team) return json(404, {error: 'Update the Controller to use Teams.'});
        if (request.method !== 'POST' || !isTeamSeat(payload)) return json(400, {error: 'Invalid Team session request.'});
        try { return json(200, await team.create(payload)); }
        catch (error) { return json(409, {error: error instanceof Error ? error.message : 'Team session creation failed.'}); }
      }
      const selectedProvider = request.method === 'GET' ? url.searchParams.get('providerId') : payload?.providerId;
      const existing = request.sessionId ? sessions.byAgent(request.sessionId) : undefined;
      // Uplink recovery may rebind a still-live session after its provider is disabled.
      // It must not open another native session or revive an idle released session.
      const recovering = request.method === 'POST' && (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach')
        && existing?.providerId === selectedProvider && existing?.nativeSessionId === payload?.nativeSessionId
        && !!existing && !!liveAgent(existing.agentId) && payload?.takeOver === undefined;
      if (!recovering && typeof selectedProvider === 'string' && options.providerEnabled?.(selectedProvider) === false) {
        throw new HostRequestError(403, 'provider_disabled', 'This provider is disabled or unavailable on the Host. Enable it in Settings.');
      }
      if (request.method === 'GET') {
        const providerId = requiredString(url.searchParams.get('providerId'), 'providerId');
        const directory = providers.require(providerId).directory;
        if (url.pathname === '/remote/workspace-folders') return json(200, await browseWorkspaceFolders(url.searchParams, options.executionPolicy, (await directory.workspaces())[0]?.path));
        if (url.pathname === '/remote/workspaces') return json(200, { workspaces: await directory.workspaces() });
        if (url.pathname === '/remote/models') return json(200, await (directory.models?.() ?? { models: [] }));
        if (url.pathname === '/remote/session/refs') {
          if (!sessionRefs) throw new HostRequestError(400, 'unsupported_configuration', 'Session references are unavailable. Update the Controller.');
          return json(200, await describeSessionRefs({ providerId, nativeSessionId: requiredString(url.searchParams.get('nativeSessionId'), 'nativeSessionId') }, sessionRefs));
        }
        const catalog = providers.catalog(providerId)!;
        if (url.pathname === '/remote/catalog/listing') {
          if (!directory.listing) throw new HostRequestError(400, 'unsupported_configuration', 'Manual listing is unavailable for this provider.');
          await directory.list();
          return json(200, directory.listing.status());
        }
        if (url.pathname === '/remote/catalog') return json(200, await catalog.page({ cursor: url.searchParams.get('cursor') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined }));
        if (url.pathname === '/remote/catalog/session') {
          const nativeSessionId = requiredString(url.searchParams.get('nativeSessionId'), 'nativeSessionId');
          const summary = directory.sessionSummary ? await directory.sessionSummary(nativeSessionId) : await catalog.session(nativeSessionId);
          if (!summary) throw new HostRequestError(404, 'session_unavailable', 'The native session is unavailable.');
          return json(200, summary);
        }
        if (url.pathname === '/remote/catalog/revision') return json(200, { revision: await catalog.revision() });
      }
      if (request.method === 'POST') {
        const payload = parseBody(request.body);
        if (url.pathname === '/remote/catalog/listing') {
          const directory = providers.require(requiredString(payload.providerId, 'providerId')).directory;
          if (!directory.listing) throw new HostRequestError(400, 'unsupported_configuration', 'Manual listing is unavailable for this provider.');
          if (Object.keys(payload).some(key => key !== 'providerId')) throw new HostRequestError(400, 'invalid_request', 'Only providerId is accepted.');
          void directory.listing.refresh().catch(() => undefined);
          return json(202, directory.listing.status());
        }
        if (url.pathname === '/remote/session/call') {
          // Through the Relay only the owner asks: the website, the command line it signed in, or a Controller using it.
          if (Object.keys(payload).some(key => key !== 'request') || request.sessionId) throw new HostRequestError(400, 'invalid_request', 'A session command is required.');
          return json(200, await callSession(payload.request, { kind: 'owner' }));
        }
        if (url.pathname === '/remote/session/refs') {
          if (!sessionRefs) throw new HostRequestError(400, 'unsupported_configuration', 'Session references are unavailable. Update the Controller.');
          const holder = { providerId: requiredString(payload.providerId, 'providerId'), nativeSessionId: requiredString(payload.nativeSessionId, 'nativeSessionId') };
          const target = payload.target as unknown;
          if ((payload.action !== 'add' && payload.action !== 'remove') || !validTarget(target) || request.sessionId
            || Object.keys(payload).some(key => !['providerId', 'nativeSessionId', 'action', 'target'].includes(key))) {
            throw new HostRequestError(400, 'invalid_request', 'Name the reference to add or remove.');
          }
          providers.require(holder.providerId);
          try { return json(200, await changeSessionRef(holder, payload.action, { providerId: target.providerId, nativeSessionId: target.nativeSessionId }, sessionRefs)); }
          catch (error) {
            if (error instanceof SessionRefError) throw new HostRequestError(error.code === 'session_not_found' ? 404 : 400, error.code, error.message);
            throw error;
          }
        }
        if (url.pathname === '/remote/session/rename') {
          const rename = parseRenameRequest(request, payload);
          const { providerId, nativeSessionId, title } = rename;
          const directory = providers.require(providerId).directory;
          if (!directory.renameSession) throw new HostRequestError(400, 'unsupported_configuration', 'Native session renaming is unavailable. Update the Controller.');
          const targets = mutationFamily([nativeRef({ providerId, nativeSessionId })]);
          let result: { title: string };
          try {
            result = await operationCache.execute({ operationId: rename.operationId(), scope: operationScope(request),
              kind: 'rename_session', target: JSON.stringify([providerId, nativeSessionId]), parameters: { title } }, {
              mutationTargets: targets.map(nativeSessionRefKey), admit: entry => successionBoundary?.admit(targets, entry.key),
              run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId: String(payload.operationId), kind: 'execute_command', parameters: {}, maximumResultBytes: 8192 }, operationScope(request), work, entry) : work(),
              validate: () => directory.validateSessionRename?.(nativeSessionId, title),
              beforeDispatch: () => successionBoundary?.recheck(targets),
              dispatch: entry => directoryNativeEffect(entry, targets.map(nativeSessionRefKey), async () => ({ title: await directory.renameSession!(nativeSessionId, title) })),
            });
          } catch (error) {
            if (!(error instanceof OperationCacheError) || error.code !== 'operation_outcome_unknown') throw error;
            const confirmed = await directory.sessionTitle?.(nativeSessionId).catch(() => undefined);
            if (confirmed === title) return json(200, { title: confirmed });
            throw new OperationCacheError('operation_outcome_unknown', 'The session name could not be confirmed. Retry to check the same change.');
          }
          // A retry must not overwrite newer native metadata with its cached result.
          const currentTitle = await directory.sessionTitle?.(nativeSessionId);
          return json(200, { title: currentTitle ?? result.title });
        }
        if (url.pathname === '/remote/workspace-folders/create') {
          providers.require(requiredString(payload.providerId, 'providerId'));
          if (request.sessionId) throw new HostRequestError(400, 'invalid_request', 'Folder creation does not target a session.');
          return json(201, await createWorkspaceFolder(payload.parentPath, payload.name, options.executionPolicy));
        }
        if (url.pathname === '/remote/stop') {
          const operationId = parseStopRequest(request, payload);
          const targetBindings = sessions.live().map(({ binding }) => binding);
          const targets = targetBindings.map(binding => binding.agentId);
          const mutationTargets = succession ? [...new Map(targetBindings.map(binding => { const target = nativeRef(binding); return [nativeSessionRefKey(target), target] as const; })).values()] : [];
          const results = await operationCache.execute({
            operationId,
            scope: operationScope(request),
            kind: 'stop_host_sessions',
            target: 'host',
            parameters: null,
          }, {
            mutationTargets: mutationTargets.map(nativeSessionRefKey),
            admit: entry => successionBoundary?.admit(mutationTargets, entry.key),
            run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId, kind: 'cancel', parameters: null, maximumResultBytes: 256 * 1024 }, operationScope(request), work, entry) : work(),
            dispatch: () => Promise.all(targets.map(cancelAgent)),
            maximumResultBytes: 256 * 1024,
          });
          return json(200, { results });
        }
        if (url.pathname === '/remote/create') return await create(request, payload, context);
        if (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach') {
          const { proposedAgentId, providerId, nativeSessionId, parent, takeOver } = parseAttachRequest(request, payload);
          await markShared(payload, providerId, nativeSessionId);
          return json(200, publicBinding(await tracked(project(providerId, proposedAgentId, nativeSessionId, parent, takeOver, false, operationScope(request)))));
        }
      }
      throw new HostRequestError(400, 'invalid_request', 'Remote Host request is invalid.');
    } catch (error) {
      const { result, cause } = failureResponse(error, request);
      if (cause) failureCauses.set(result, cause);
      return result;
    }
  }
  async function cancelAgent(agentId: string) {
    const { cancelTimeoutMs, idle, relay } = ctx;
    const release = idle.retain(agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([relay.requireAgent(agentId).cancel(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation deadline exceeded.')), cancelTimeoutMs);
      })]);
      return { agentId, status: 'cancelled' as const };
    } catch (error) {
      return error instanceof UnsupportedAgentCapabilityError
        ? { agentId, status: 'unsupported' as const, message: 'The native session does not support cancellation.' }
        : { agentId, status: 'failed' as const, message: 'Native cancellation did not complete.' };
    } finally { clearTimeout(timer); release(); }
  }
  return { create, control, controlRequest, cancelAgent };
}
