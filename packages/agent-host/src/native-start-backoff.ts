import type { AgentRemoteHttpResult } from '@orchardworks/agent-remote-relay';

const initialDelayMs = 5_000;
const maxDelayMs = 60_000;

/** Which native session an attach request would start, and whether it is an explicit takeover. */
export function nativeStartTarget(path: string, method: string, requestBody: string | undefined): { key: string; takeOver: boolean; providerId: string; nativeSessionId: string } | undefined {
  if (method !== 'POST' || (path !== '/remote/attach' && path !== '/remote/child/attach')) return undefined;
  try {
    const payload = JSON.parse(requestBody ?? '') as Record<string, unknown> | null;
    if (!payload || typeof payload.providerId !== 'string' || typeof payload.nativeSessionId !== 'string') return undefined;
    const parent = path === '/remote/child/attach' && typeof payload.parentNativeSessionId === 'string' ? payload.parentNativeSessionId : null;
    return { key: JSON.stringify([payload.providerId, parent, payload.nativeSessionId]), takeOver: payload.takeOver !== undefined,
      providerId: payload.providerId, nativeSessionId: payload.nativeSessionId };
  } catch { return undefined; }
}

function nativeStartFailure(result: AgentRemoteHttpResult): boolean {
  if (result.status < 500) return false;
  try {
    const code = (JSON.parse(result.body) as { code?: unknown }).code;
    return code === 'session_attach_failed' || typeof code === 'string' && code.startsWith('native_');
  } catch { return false; }
}

/**
 * Clients retry retryable attach failures automatically, and every attempt can spawn a native process.
 * After a native start fails, attaches to the same session repeat that failure until a backoff expires
 * instead of spawning again. An explicit takeover always tries immediately.
 */
export function createNativeStartBackoff(now: () => number = Date.now) {
  const failures = new Map<string, { count: number; until: number; result: AgentRemoteHttpResult }>();
  return {
    blocked(target: { key: string; takeOver: boolean }): AgentRemoteHttpResult | undefined {
      const failure = failures.get(target.key);
      return failure && !target.takeOver && failure.until > now() ? failure.result : undefined;
    },
    settle(target: { key: string }, result: AgentRemoteHttpResult): void {
      if (!nativeStartFailure(result)) {
        if (result.status < 500) failures.delete(target.key);
        return;
      }
      const count = (failures.get(target.key)?.count ?? 0) + 1;
      failures.set(target.key, { count, until: now() + Math.min(initialDelayMs * 2 ** (count - 1), maxDelayMs), result });
    },
  };
}
