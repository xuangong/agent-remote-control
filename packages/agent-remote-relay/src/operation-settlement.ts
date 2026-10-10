import { randomUUID } from 'node:crypto';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { OperationCacheError, type OperationCache, type MutationEntry } from './operation-cache.js';
import type { SessionWireAgent, SessionWireOperation, SessionWireOperationExecutor } from './session-wire.js';

/** Trusted runtime facts and resource ownership; settlement rules remain in the shared cache. */
export interface OperationLifecycle {
  target?(agent: SessionWireAgent): string;
  admit?(agent: SessionWireAgent): void;
  mutationTargets?(agent: SessionWireAgent): readonly string[];
  admission?(agent: SessionWireAgent, operation: SessionWireOperation, scope: string, entry: MutationEntry): () => void;
  run?<T>(agent: SessionWireAgent, operation: SessionWireOperation, scope: string, entry: MutationEntry, work: () => Promise<T>): Promise<T>;
  /** Recheck authoritative Host admission after queued preparation, immediately before native dispatch. */
  beforeDispatch?(agent: SessionWireAgent, operation: SessionWireOperation): void;
  /** Carries Host operation identity across asynchronous native preparation; never replaces settlement. */
  dispatch?<T>(agent: SessionWireAgent, operation: SessionWireOperation, scope: string, work: () => Promise<T>): Promise<T>;
  retain?(agent: SessionWireAgent): () => void;
  uncertain?(agent: SessionWireAgent): void;
}

export function createOperationExecutor(
  cache: OperationCache,
  scope: string,
  lifecycle: OperationLifecycle = {},
  ephemeralTargets: WeakMap<SessionWireAgent, string> = new WeakMap(),
): SessionWireOperationExecutor {
  return async (agent, operation, work) => {
    const snapshot = agent.snapshot().payload;
    let ephemeralTarget = ephemeralTargets.get(agent);
    if (!snapshot.runtimeInfo.sessionId && !ephemeralTarget) {
      ephemeralTarget = randomUUID();
      ephemeralTargets.set(agent, ephemeralTarget);
    }
    const target = lifecycle.target?.(agent) ?? JSON.stringify([
      snapshot.providerId, snapshot.runtimeInfo.sessionId ? 'native' : 'ephemeral', snapshot.runtimeInfo.sessionId ?? ephemeralTarget,
    ]);
    const beforeDispatch = () => {
      try { lifecycle.beforeDispatch?.(agent, operation); work.beforeDispatch?.(); }
      catch (error) {
        if (error instanceof AgentOperationRejectedError) throw error;
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'operation_rejected';
        throw new AgentOperationRejectedError(code, error instanceof Error ? error.message : 'Host admission rejected the operation.');
      }
    };
    const dispatch = () => agent.runOperation ? agent.runOperation(work.dispatch, beforeDispatch)
      : Promise.resolve().then(() => { beforeDispatch(); return work.dispatch(); });
    try {
      return await cache.execute({
        operationId: operation.operationId, scope, kind: operation.kind, target, parameters: operation.parameters,
      }, { ...work,
        mutationTargets: lifecycle.mutationTargets?.(agent),
        admit: entry => {
          lifecycle.admit?.(agent);
          const releaseAdmission = lifecycle.admission?.(agent, operation, scope, entry);
          let releaseResource: (() => void) | undefined;
          try { releaseResource = lifecycle.retain?.(agent); }
          catch (error) { releaseAdmission?.(); throw error; }
          return () => { try { releaseAdmission?.(); } finally { releaseResource?.(); } };
        },
        run: lifecycle.run ? (entry, run) => lifecycle.run!(agent, operation, scope, entry, run) : undefined,
        dispatch: () => lifecycle.dispatch ? lifecycle.dispatch(agent, operation, scope, dispatch) : dispatch(),
        maximumResultBytes: operation.maximumResultBytes,
      });
    } catch (error) {
      if (error instanceof OperationCacheError && ['operation_outcome_unknown', 'native_file_limit'].includes(error.code)) {
        try { lifecycle.uncertain?.(agent); } catch { /* Resource diagnostics cannot alter settlement. */ }
      }
      throw error;
    }
  };
}
