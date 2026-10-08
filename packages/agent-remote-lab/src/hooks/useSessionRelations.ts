import { useEffect, useMemo, useRef } from 'react';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import type { ForkStore, SessionFork } from '../session-forks.js';
import { workspaceFetch } from '../workspace-access.js';
import { sessionKey } from '../session-tree.js';

/** Sync navigation independently of native observation, local drafts and delivery receipts. */
export function useSessionRelations(baseUrl: string, enabled: boolean, sides: ForkStore, asks: ForkStore, current?: string, accountScoped = enabled) {
  const refreshRef = useRef<() => Promise<void>>();
  const setLinkedRef = useRef<(record: SessionFork, linked: boolean) => Promise<void>>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const url = new URL('v1/session-relations', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsupported = false;
    let navigationChange = 0;
    let changing = false;
    const rejectedImports = new Set<string>();
    const applyRelations = (relations: readonly SessionRelation[]) => {
      sides.setSharedRelations(relations.filter(item => item.kind === 'side'));
      asks.setSharedRelations(relations.filter(item => item.kind === 'ask'));
    };
    async function synchronize() {
      if (unsupported || controller.signal.aborted) return;
      const startedAtChange = navigationChange;
      const currentResponse = () => !controller.signal.aborted && startedAtChange === navigationChange;
      const response = await workspaceFetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (response.status === 404) { unsupported = true; return; }
      if (!response.ok) throw new Error('Related sessions could not be checked. Reconnect before opening Ask.');
      let relations = readRelations(await response.json());
      if (!currentResponse()) return;
      let importedCount = 0;
      const known = new Set(relations.map(item => sessionKey(item.target)));
      for (const [store, kind] of [[sides, 'side'], [asks, 'ask']] as const) {
        for (const record of store.all()) {
          if (!currentResponse()) return;
          if (importedCount >= 4 || record.remote || record.linked === false || record.mode !== 'reference' || !record.target || !record.configured || record.creationKey
            || !record.target.hostId || record.target.hostId === 'local' || known.has(sessionKey(record.target)) || rejectedImports.has(record.id)) continue;
          const { hostId, providerId, nativeSessionId } = record.target;
          importedCount++;
          const imported = await workspaceFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            body: JSON.stringify({ hostId, providerId, nativeSessionId, sourceNativeSessionId: record.source.nativeSessionId, id: record.id, kind, createdAt: record.capturedAt }) });
          if (imported.ok) {
            relations = readRelations(await imported.json());
            for (const item of relations) known.add(sessionKey(item.target));
          } else if ([400, 403, 409].includes(imported.status)) rejectedImports.add(record.id);
          else break;
        }
      }
      if (currentResponse()) applyRelations(relations);
    }
    function refresh(): Promise<void> {
      return pending ??= synchronize().finally(() => { pending = undefined; });
    }
    refreshRef.current = refresh;
    setLinkedRef.current = async (record, linked) => {
      if (changing) throw new Error('The side link is already being changed. Wait before trying again.');
      if (!record.target) throw new Error('The side session is not available yet.');
      if (!record.remote && !record.relationId) await refresh();
      if (changing) throw new Error('The side link is already being changed. Wait before trying again.');
      const latest = sides.get(record.id);
      if (unsupported || !latest.relationId) throw new Error('The shared side link is unavailable. Refresh before trying again.');
      const { hostId, providerId, nativeSessionId } = latest.target!;
      const expectedRevision = record.revision ?? 0;
      changing = true;
      navigationChange++;
      try {
        let response: Response;
        try {
          response = await workspaceFetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            body: JSON.stringify({ hostId, providerId, nativeSessionId, sourceNativeSessionId: record.source.nativeSessionId,
              id: latest.relationId, linked, expectedRevision }) });
        } catch {
          throw new Error('The side link change could not be confirmed. Refresh its status before retrying.');
        }
        const data: unknown = await response.json().catch(() => undefined);
        if (controller.signal.aborted) throw new Error('The side link change could not be confirmed. Refresh its status before retrying.');
        if (response.status === 409) {
          try { applyRelations(readRelations(data)); }
          catch { await synchronize().catch(() => {}); }
          throw new Error('The side link changed on another device. Refresh before trying again.');
        }
        if (!response.ok) {
          const error = (data as { error?: string | { message?: unknown } } | undefined)?.error;
          const message = typeof error === 'string' ? error : error?.message;
          throw new Error(typeof message === 'string' && message.trim() ? message : 'The side link could not be changed. Reconnect and try again.');
        }
        let relations: SessionRelation[];
        try { relations = readRelations(data); }
        catch { throw new Error('The side link change could not be confirmed. Refresh its status before retrying.'); }
        const confirmed = relations.find(item => item.id === latest.relationId && item.kind === 'side'
          && sessionKey(item.target) === sessionKey(latest.target!) && item.source.nativeSessionId === record.source.nativeSessionId);
        if (!confirmed || (confirmed.linked !== false) !== linked || (confirmed.revision ?? 0) < expectedRevision) {
          throw new Error('The side link change could not be confirmed. Refresh its status before retrying.');
        }
        applyRelations(relations);
      } finally { changing = false; navigationChange++; }
    };
    const backgroundRefresh = () => {
      if (document.visibilityState !== 'hidden') void refresh().catch(() => {});
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(backgroundRefresh, 100); };
    const removeSides = sides.subscribe(schedule); const removeAsks = asks.subscribe(schedule);
    window.addEventListener('focus', schedule); document.addEventListener('visibilitychange', schedule);
    const poll = setInterval(backgroundRefresh, 10000);
    backgroundRefresh();
    return () => { refreshRef.current = undefined; setLinkedRef.current = undefined; controller.abort(); clearTimeout(timer); clearInterval(poll); removeSides(); removeAsks();
      window.removeEventListener('focus', schedule); document.removeEventListener('visibilitychange', schedule); };
  }, [baseUrl, enabled, sides, asks]);
  // Focus requests fresh relations without retiring other views' in-flight recovery.
  useEffect(() => { if (enabled) void refreshRef.current?.().catch(() => {}); }, [enabled, current]);
  return useMemo(() => Object.assign(async () => { if (enabled) await refreshRef.current?.(); }, {
    setLinked: async (record: SessionFork, linked: boolean) => {
      let local: SessionFork;
      try { local = sides.get(record.id); }
      catch { throw new Error('Only side links can be changed here.'); }
      if (!record.target || !local.target || sessionKey(record.target) !== sessionKey(local.target)
        || sessionKey(record.source) !== sessionKey(local.source)) throw new Error('The side link changed. Refresh before trying again.');
      if (!accountScoped) { sides.setLinked(record.id, linked, record.revision ?? 0); return; }
      if (!enabled || !setLinkedRef.current) throw new Error('Workspace access is restoring. Try again when connected.');
      if (local.mode !== 'reference') { sides.setLinked(record.id, linked, record.revision ?? 0); return; }
      await setLinkedRef.current(record, linked);
    },
  }), [enabled, accountScoped, sides]);
}

function readRelations(value: unknown): SessionRelation[] {
  const relations = (value as { relations?: unknown } | null)?.relations;
  const session = (item: unknown) => !!item && typeof item === 'object' && ['hostId', 'providerId', 'nativeSessionId', 'agentId', 'title']
    .every(key => typeof (item as Record<string, unknown>)[key] === 'string');
  if (!Array.isArray(relations) || !relations.every((item: SessionRelation) => item && typeof item.id === 'string'
    && (item.kind === 'side' || item.kind === 'ask') && typeof item.createdAt === 'string' && session(item.source) && session(item.target)
    && (item.linked === undefined || typeof item.linked === 'boolean')
    && (item.revision === undefined || Number.isSafeInteger(item.revision) && item.revision >= 0))) {
    throw new Error('Related sessions returned an invalid response. Refresh before trying again.');
  }
  return relations;
}
