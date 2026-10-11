import type { OpenedSession, SuccessionPrepareInput } from './directory-client.js';
export interface SessionSuccessionIntent { source: OpenedSession; operation: SuccessionPrepareInput; cancelRequested?: boolean }
const key = (scope: string) => `agent-remote:succession-intent:${scope}`;
/** Retain the tab-local request identity, never a projected successor binding or credentials. */
export function loadSuccessionIntent(scope: string): SessionSuccessionIntent | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(scope)) ?? 'null');
    if (!value || !value.source || !value.operation || value.cancelRequested !== undefined && typeof value.cancelRequested !== 'boolean') return undefined;
    const { source, operation } = value;
    if (![source.hostId, source.providerId, source.nativeSessionId, source.agentId, operation.operationId, operation.providerId, operation.nativeSessionId, operation.targetProviderId].every(item => typeof item === 'string' && item.length > 0)
      || source.providerId !== operation.providerId || source.nativeSessionId !== operation.nativeSessionId
      || !Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 1) return undefined;
    return value;
  } catch { return undefined; }
}
export function saveSuccessionIntent(scope: string, intent: SessionSuccessionIntent): void {
  sessionStorage.setItem(key(scope), JSON.stringify(intent));
}
export function clearSuccessionIntent(scope: string): void { sessionStorage.removeItem(key(scope)); }
