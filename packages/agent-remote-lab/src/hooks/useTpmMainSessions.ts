import { useEffect, useMemo, useReducer } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { tpmMainTarget, type TpmMainSession } from '../tpm-main-sessions.js';
import type { TpmItem } from './useTpmWork.js';

/** Resolve list labels from the directory without opening native sessions. */
export function useTpmMainSessions(baseUrl: string, enabled: boolean, open: boolean, works: readonly TpmItem[],
  known: readonly TpmMainSession[], transport: RemoteAgentTransport) {
  const cache = useMemo(() => new Map<string, TpmMainSession>(), [baseUrl, enabled, transport]);
  const [, changed] = useReducer(value => value + 1, 0);
  const knownKeys = new Set(known.filter(item => item.title.trim()).map(sessionKey));
  const targets = new Map(works.map(item => {
    const target = tpmMainTarget(item);
    return [sessionKey(target), { ...target, online: item.online }];
  }));
  const lookupKey = JSON.stringify([...targets.values()].filter(target => !knownKeys.has(sessionKey(target))).sort((a, b) => sessionKey(a).localeCompare(sessionKey(b))));
  useEffect(() => {
    if (!enabled || !open) return;
    const controller = new AbortController();
    const groups = new Map<string, ReturnType<typeof tpmMainTarget>[]>();
    for (const target of JSON.parse(lookupKey) as Array<ReturnType<typeof tpmMainTarget> & { online: boolean }>) {
      if (!target.online || cache.has(sessionKey(target))) continue;
      const key = JSON.stringify([target.hostId, target.providerId]);
      groups.set(key, [...(groups.get(key) ?? []), target]);
    }
    // One traversal per Host/provider, shared by all unresolved main sessions.
    for (const targets of groups.values()) void (async () => {
      const { hostId, providerId } = targets[0]!;
      const missing = new Set(targets.map(target => target.nativeSessionId));
      const directory = new SessionDirectoryClient(baseUrl, undefined, hostId);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const page = await directory.list(providerId, cursor, signal);
          if (signal.aborted) return;
          let updated = false;
          for (const session of page.items) {
            if (session.providerId !== providerId || !missing.has(session.nativeSessionId)) continue;
            const value = { ...session, hostId };
            cache.set(sessionKey(value), value); missing.delete(session.nativeSessionId); updated = true;
          }
          if (updated) changed();
          cursor = page.hasMore ? page.nextCursor : undefined;
          if (!cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        } while (missing.size && !signal.aborted);
      } catch { /* Keep the native ID as a usable label; retry unresolved names on the next opening. */ }
    })();
    return () => controller.abort();
  }, [baseUrl, enabled, open, lookupKey, cache]);
  useEffect(() => {
    if (!enabled) return;
    return transport.onSessionTitle?.(session => {
      const key = sessionKey(session), previous = cache.get(key);
      if (previous && previous.title !== session.title) { cache.set(key, { ...previous, title: session.title }); changed(); }
    });
  }, [enabled, transport, cache]);
  const result = new Map<string, TpmMainSession>();
  if (enabled) {
    for (const key of targets.keys()) { const value = cache.get(key); if (value) result.set(key, value); }
    for (const value of known) if (targets.has(sessionKey(value)) && value.title.trim()) result.set(sessionKey(value), { ...result.get(sessionKey(value)), ...value });
  }
  return result;
}
