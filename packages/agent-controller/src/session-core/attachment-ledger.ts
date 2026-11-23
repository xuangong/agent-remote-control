import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import type { SessionWireAgent } from '@orchardworks/agent-session-runtime';
import type { WorkerTools } from '../bot-tools.js';

/** What a native attachment was opened from: the provider's session, and the identity of the creation result or prefix handle it was opened with. */
export interface NativeAttachment { session: AgentSession; nativeCreation?: string; nativePrefix?: string }

/**
 * Attachment ledger: the one owner of what the Controller knows about each attached session beyond what the Relay and the bindings hold.
 *
 * Contract.
 * - A projection session is staged under its agent id before the Relay creates the agent, and taken exactly once by the Relay's `createSession`:
 *   `takeProjection` returns it and forgets it. A session never staged is `undefined`. `discardProjection(id, session)` forgets the staged session only
 *   while it is still the one given; `discardProjection(id)` forgets whatever is staged. Both say whether they forgot one.
 * - A native attachment is recorded against the live agent it was opened for and read back by that agent. It lives as long as the agent object does.
 * - Worker tools are either applied to an agent or not; an agent never recorded has none applied.
 * - An agent is uncertain from `markUncertain` until `clearUncertain`; its idle release waits while it is. Nothing else changes uncertainty.
 *
 * Mutable state: the four collections, assigned only here. Callers hold no reference to any of them.
 */
export interface AttachmentLedger {
  stageProjection(agentId: string, session: AgentSession): void;
  takeProjection(agentId: string): AgentSession | undefined;
  discardProjection(agentId: string, session?: AgentSession): boolean;
  recordAttachment(agent: SessionWireAgent, attachment: NativeAttachment): void;
  attachmentOf(agent: SessionWireAgent): NativeAttachment | undefined;
  recordWorkerTools(agentId: string, applied: WorkerTools): void;
  workerToolsApplied(agentId: string): WorkerTools;
  markUncertain(agentId: string): void;
  clearUncertain(agentId: string): void;
  isUncertain(agentId: string): boolean;
}

export function createAttachmentLedger(): AttachmentLedger {
  const projections = new Map<string, AgentSession>();
  const attachments = new WeakMap<SessionWireAgent, NativeAttachment>();
  const workerTools = new Map<string, WorkerTools>();
  const uncertain = new Set<string>();
  return {
    stageProjection: (agentId, session) => { projections.set(agentId, session); },
    takeProjection(agentId) {
      const session = projections.get(agentId);
      projections.delete(agentId);
      return session;
    },
    discardProjection(agentId, session) {
      if (session !== undefined && projections.get(agentId) !== session) return false;
      return projections.delete(agentId);
    },
    recordAttachment: (agent, attachment) => { attachments.set(agent, attachment); },
    attachmentOf: agent => attachments.get(agent),
    recordWorkerTools: (agentId, applied) => { workerTools.set(agentId, applied); },
    workerToolsApplied: agentId => workerTools.get(agentId) ?? 'none',
    markUncertain: agentId => { uncertain.add(agentId); },
    clearUncertain: agentId => { uncertain.delete(agentId); },
    isUncertain: agentId => uncertain.has(agentId),
  };
}
