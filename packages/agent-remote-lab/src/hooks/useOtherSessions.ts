import { useCallback, useEffect, useRef, useState } from 'react';
import { DirectoryError, type SessionCatalogPage, type SessionDirectoryClient } from '../directory-client.js';
import { sortDirectorySessions } from '../bot-roster.js';

export interface OtherSessionSource { id: string; hostId: string; providerId: string; directory: SessionDirectoryClient; online: boolean }
export interface OtherSessionSourceState extends OtherSessionSource { loading: boolean; hasMore: boolean; error?: string; expired: boolean }
interface DirectoryPages { source: OtherSessionSource; pages: SessionCatalogPage[]; loaded: boolean; loading: boolean; expired: boolean; error?: string; generation: number; abort?: AbortController }
export function useOtherSessions(sources: readonly OtherSessionSource[], enabled: boolean) {
  const cache = useRef(new Map<string, DirectoryPages>());
  const latest = useRef({ sources, enabled }); latest.current = { sources, enabled };
  const identities = useRef(new WeakMap<SessionDirectoryClient, number>());
  const counter = useRef(0);
  const signature = JSON.stringify(sources.map(source => {
    if (!identities.current.has(source.directory)) identities.current.set(source.directory, ++counter.current);
    return [source.id, source.hostId, source.providerId, source.online, identities.current.get(source.directory)];
  }));
  const [, render] = useState(0);
  const mounted = useRef(false);
  const publish = () => { if (mounted.current) render(value => value + 1); };
  const readPage = useCallback(async (id: string, append: boolean): Promise<void> => {
    const entry = cache.current.get(id), source = latest.current.sources.find(source => source.id === id);
    if (!entry || !source || !latest.current.enabled || !source.online || append && (entry.loading || entry.expired || !entry.pages.at(-1)?.hasMore)) return;
    const cursor = append ? entry.pages.at(-1)?.nextCursor : undefined;
    if (append && !cursor) return;
    entry.abort?.abort(); const abort = new AbortController(), generation = ++entry.generation;
    entry.abort = abort; entry.loading = true; entry.error = undefined; publish();
    const live = () => mounted.current && latest.current.enabled && cache.current.get(id) === entry && generation === entry.generation && !abort.signal.aborted;
    try {
      const page = await source.directory.list(source.providerId, cursor, abort.signal);
      if (!live()) return;
      entry.pages = append ? [...entry.pages, page] : [page]; entry.loaded = true; entry.expired = false;
    } catch (error) {
      if (!live()) return;
      entry.error = error instanceof Error ? error.message : String(error);
      if (error instanceof DirectoryError && error.code === 'cursor_expired') entry.expired = true;
    } finally { if (live()) { entry.loading = false; entry.abort = undefined; publish(); } }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const ids = new Set(sources.map(source => source.id));
    for (const [id, entry] of cache.current) if (!ids.has(id)) { entry.abort?.abort(); entry.generation++; cache.current.delete(id); }
    for (const source of sources) {
      let entry = cache.current.get(source.id);
      if (entry && (entry.source.directory !== source.directory || entry.source.hostId !== source.hostId || entry.source.providerId !== source.providerId)) { entry.abort?.abort(); entry.generation++; entry = undefined; }
      if (!entry) { entry = { source, pages: [], loaded: false, loading: false, expired: false, generation: 0 }; cache.current.set(source.id, entry); }
      entry.source = source;
      if (!enabled || !source.online) { entry.abort?.abort(); entry.generation++; entry.loading = false; }
      else if (!entry.loaded && !entry.loading) void readPage(source.id, false);
    }
    publish();
    return () => {
      mounted.current = false;
      for (const entry of cache.current.values()) { entry.abort?.abort(); entry.generation++; entry.loading = false; }
    };
  }, [signature, enabled, readPage]);
  const states: OtherSessionSourceState[] = sources.map(source => {
    const entry = cache.current.get(source.id);
    return { ...source, loading: enabled && !!entry?.loading, hasMore: !!entry?.pages.at(-1)?.hasMore, expired: !!entry?.expired, ...(entry?.error ? { error: entry.error } : {}) };
  });
  const sessions = sortDirectorySessions(sources.flatMap(source => {
    const entry = cache.current.get(source.id);
    if (!entry || entry.source.directory !== source.directory || entry.source.hostId !== source.hostId || entry.source.providerId !== source.providerId) return [];
    return entry.pages.flatMap(page => page.items.map(({ state: _, ...session }) => ({ ...session, hostId: source.hostId, providerId: source.providerId })));
  }));
  return { sessions, sources: states, refresh: async (id?: string) => { await Promise.all((id ? [id] : latest.current.sources.map(source => source.id)).map(id => readPage(id, false))); }, loadMore: (id: string) => readPage(id, true) };
}
