import { randomUUID } from 'node:crypto';
import { OperationCacheError, type OperationCache } from './operation-cache.js';
import type { SessionWireAgent, SessionWireOperationExecutor } from './session-wire.js';

/** Trusted runtime facts and resource ownership; settlement rules remain in the shared cache. */
export interface OperationLifecycle {
  target?(agent: SessionWireAgent): string;
  admit?(agent: SessionWireAgent): void;
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
    lifecycle.admit?.(agent);
    const snapshot = agent.snapshot().payload;
    let ephemeralTarget = ephemeralTargets.get(agent);
    if (!snapshot.runtimeInfo.sessionId && !ephemeralTarget) {
      ephemeralTarget = randomUUID();
      ephemeralTargets.set(agent, ephemeralTarget);
    }
    const target = lifecycle.target?.(agent) ?? JSON.stringify([
      snapshot.providerId, snapshot.runtimeInfo.sessionId ? 'native' : 'ephemeral', snapshot.runtimeInfo.sessionId ?? ephemeralTarget,
    ]);
    const release = lifecycle.retain?.(agent);
    try {
      return await cache.execute({
        operationId: operation.operationId, scope, kind: operation.kind, target, parameters: operation.parameters,
      }, { ...work,
        dispatch: () => agent.runOperation ? agent.runOperation(work.dispatch, work.beforeDispatch) : work.dispatch(),
        maximumResultBytes: operation.maximumResultBytes,
      });
    } catch (error) {
      if (error instanceof OperationCacheError && ['operation_outcome_unknown', 'native_file_limit'].includes(error.code)) {
        try { lifecycle.uncertain?.(agent); } catch { /* Resource diagnostics cannot alter settlement. */ }
      }
      throw error;
    } finally { try { release?.(); } catch { /* Resource cleanup cannot alter settlement. */ } }
  };
}
