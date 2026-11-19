import type { AgentEmptyCreationResult, AgentPersistenceHandle, AgentSession, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef, TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import type { AgentRemoteHttpResult, AgentRemoteRelay, OperationCache, RemoteHostControlRequest, RemoteHostSessionLease, SessionBindings, SessionWireAgent } from '@orchardworks/agent-session-runtime';

import type { createHostStatusReader } from '../host-status.js';
import type { createIdleSessions } from '../idle-sessions.js';
import type { SessionSuccessionBoundary } from '../session-succession-boundary.js';
import type { SessionSuccessionContextStore } from '../session-succession-context.js';
import type { SessionSuccessionEnrollment } from '../session-succession-enrollment.js';
import type { SessionSuccessionService } from '../session-succession-service.js';
import type { SessionSuccessionStore } from '../session-succession-store.js';
import type { SessionSuccessionCoordinator } from '../session-succession.js';
import type { WorkerSupport } from '../call-for-support-worker.js';
import type { SessionRoles } from '../session-role-succession.js';
import type { TeamRuntime } from '../team.js';
import type { TpmCoordinator, TpmSessionAccess } from '../tpm.js';
import type { JournalPublisher } from '../publisher/journal-publisher.js';
import type { TerminalRefresh } from '../publisher/terminal-refresh.js';
import type { SessionRefContext } from '../session-refs.js';
import type { SessionCallerCatalog } from '../session-callers.js';
import type { SessionCaller, SessionCallResult } from '../session-routes.js';
import type { Admission } from './admission.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { AgentHostProviderRegistration, AgentHostRuntimeOptions, SessionBinding } from './types.js';

/** What a native attachment was opened from: the provider's session, and the identity of the creation result or prefix handle it was opened with. */
export interface NativeAttachment { session: AgentSession; nativeCreation?: string; nativePrefix?: string }

/** The adapter-owned succession evidence of a Controller configured with a state directory. */
export type NativeSuccession = Extract<NonNullable<AgentHostRuntimeOptions['succession']>, { stateDirectory: string }>['native'];

/** The succession state this Controller keeps: its identity, the store of role records, the evidence contexts and the coordinator. */
export interface SuccessionHandle {
  controllerId: string;
  store: SessionSuccessionStore;
  contexts: SessionSuccessionContextStore;
  coordinator: SessionSuccessionCoordinator;
}

/**
 * What the modules of the session core share. The host runtime builds one context and hands it to each module's factory; a module reads
 * what it needs from it when it runs, never when it is created, so the order in which the runtime builds its parts does not matter.
 *
 * Contract. The context holds no behaviour of its own: its state is owned where it is created (the registrations, the bindings, the operation cache, the
 * idle sessions), and its functions are the ones the modules call across concerns. A member that is optional configuration (`tpm`, `team`, `enrollment`,
 * `succession`) is undefined when the Controller was not configured with it.
 */
export interface SessionCoreContext {
  readonly options: AgentHostRuntimeOptions;
  readonly admission: Admission;
  readonly relay: AgentRemoteRelay;
  readonly bindings: SessionBindings;
  readonly idle: ReturnType<typeof createIdleSessions>;
  readonly operationCache: OperationCache;
  readonly hostStatus: ReturnType<typeof createHostStatusReader>;
  readonly cancelTimeoutMs: number;
  readonly successionReady: Promise<unknown>;
  readonly successionService: SessionSuccessionService | undefined;
  readonly succession: SuccessionHandle | undefined;
  readonly successionBoundary: SessionSuccessionBoundary | undefined;
  readonly tpm: TpmCoordinator | undefined;
  readonly team: TeamRuntime | undefined;
  readonly enrollment: SessionSuccessionEnrollment | undefined;
  readonly sessionRefs: SessionRefContext | undefined;
  readonly roles: SessionRoles;
  readonly providers: ProviderRegistry;
  readonly prepared: Map<string, AgentSession>;
  readonly uncertainAgents: Set<string>;
  readonly journals: JournalPublisher;
  readonly terminalRefresh: TerminalRefresh;
  readonly automationAccess: TpmSessionAccess;
  readonly sessionCatalog: SessionCallerCatalog;
  readonly workerSupport: WorkerSupport | undefined;
  readonly workerToolsApplied: Map<string, boolean>;
  readonly nativeAttachments: WeakMap<SessionWireAgent, NativeAttachment>;
  readonly successionConfig: AgentHostRuntimeOptions['succession'];
  readonly nativeSuccession: NativeSuccession;
  liveAgent(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  nativeRef(binding: Pick<SessionBinding, 'providerId' | 'nativeSessionId'>): NativeSessionRef;
  mutationFamily(targets: readonly NativeSessionRef[]): NativeSessionRef[];
  directoryOperation<T>(scope: string, operationId: string, kind: string, targets: readonly NativeSessionRef[], parameters: unknown,
    dispatch: () => Promise<T>, validate?: () => Promise<void>): Promise<T>;
  nativeFamily(providerId: string, nativeSessionId: string): SessionBinding[];
  originalCreation(target: NativeSessionRef): AgentEmptyCreationResult | undefined;
  originalNativePrefix(target: NativeSessionRef): { handle: AgentPersistenceHandle; source: NativeSessionRef } | undefined;
  assertHandoffState(target: NativeSessionRef, captured?: { epoch: string; seq: number }, allowMissing?: boolean): void;
  acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined>;
  nativePrefixExtensions(source: NativeSessionRef, actual: () => string | undefined): Promise<AgentSessionExtensions>;
  genericSuccessionSource(target: NativeSessionRef): NativeSessionRef | undefined;
  create(request: RemoteHostControlRequest, payload: Record<string, unknown>, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult>;
  controlRequest(request: RemoteHostControlRequest, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult>;
  tracked<T>(operation: Promise<T>): Promise<T>;
  project(providerId: string, proposedAgentId: string, nativeSessionId: string, parentNativeSessionId?: string, takeOver?: string, takeoverAdmitted?: boolean,
    takeoverScope?: string, qualifiedResult?: boolean): Promise<SessionBinding>;
  callSession(request: unknown, caller: SessionCaller): Promise<SessionCallResult>;
  authorizeSuccessionRead(reader: NativeSessionRef, source: NativeSessionRef): Promise<void>;
  workerExtensions(providerId: string, holder: NativeSessionRef | undefined, actual: () => NativeSessionRef | undefined): AgentSessionExtensions | undefined;
  markShared(payload: Record<string, unknown> | undefined, providerId: string, nativeSessionId: string): Promise<void>;
}

