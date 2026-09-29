import { useEffect, useRef } from 'react';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import type { ForkStore } from '../session-forks.js';
import { workspaceFetch } from '../workspace-access.js';
import { sessionKey } from '../session-tree.js';

/** Sync navigation independently of native observation, local drafts and delivery receipts. */
export function useSessionRelations(baseUrl: string, enabled: boolean, sides: ForkStore, asks: ForkStore, current?: string) {
  const refreshRef = useRef<() => Promise<void>>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const url = new URL('v1/session-relations', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsupported = false;
    const rejectedImports = new Set<string>();
    async function synchronize() {
      if (unsupported || controller.signal.aborted) return;
      const response = await workspaceFetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (response.status === 404) { unsupported = true; return; }
      if (!response.ok) throw new Error('Related sessions could not be checked. Reconnect before opening Ask.');
      const data = await response.json() as { relations: SessionRelation[] };
      if (!Array.isArray(data.relations) || controller.signal.aborted) return;
      let importedCount = 0;
      const known = new Set(data.relations.map(item => sessionKey(item.target)));
      for (const [store, kind] of [[sides, 'side'], [asks, 'ask']] as const) {
        for (const record of store.all()) {
          if (importedCount >= 4 || record.remote || record.mode !== 'reference' || !record.target || !record.configured || record.creationKey
            || !record.target.hostId || record.target.hostId === 'local' || known.has(sessionKey(record.target)) || rejectedImports.has(record.id)) continue;
          const { hostId, providerId, nativeSessionId } = record.target;
          importedCount++;
          const imported = await workspaceFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            body: JSON.stringify({ hostId, providerId, nativeSessionId, sourceNativeSessionId: record.source.nativeSessionId, id: record.id, kind, createdAt: record.capturedAt }) });
          if (imported.ok) {
            const latest = await imported.json() as { relations: SessionRelation[] };
            data.relations = latest.relations;
            for (const item of latest.relations) known.add(sessionKey(item.target));
          } else if ([400, 403, 409].includes(imported.status)) rejectedImports.add(record.id);
          else break;
        }
      }
      if (controller.signal.aborted) return;
      sides.setSharedRelations(data.relations.filter(item => item.kind === 'side'));
      asks.setSharedRelations(data.relations.filter(item => item.kind === 'ask'));
    }
    function refresh(): Promise<void> {
      return pending ??= synchronize().finally(() => { pending = undefined; });
    }
    refreshRef.current = refresh;
    const backgroundRefresh = () => {
      if (document.visibilityState !== 'hidden') void refresh().catch(() => {});
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(backgroundRefresh, 100); };
    const removeSides = sides.subscribe(schedule); const removeAsks = asks.subscribe(schedule);
    window.addEventListener('focus', schedule); document.addEventListener('visibilitychange', schedule);
    const poll = setInterval(backgroundRefresh, 10000);
    backgroundRefresh();
    return () => { refreshRef.current = undefined; controller.abort(); clearTimeout(timer); clearInterval(poll); removeSides(); removeAsks();
      window.removeEventListener('focus', schedule); document.removeEventListener('visibilitychange', schedule); };
  }, [baseUrl, enabled, sides, asks, current]);
  return async () => { if (enabled) await refreshRef.current?.(); };
}
