import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type RemoteAgentTransport, watchPageResume } from '@orchardworks/agent-remote-web';
import { SessionStarsClient, FavoritesConflict, type FavoriteChange, type FavoritesSnapshot, type StarInput } from '../session-stars-client.js';
import { sessionKey } from '../session-tree.js';
import { useFeedbackToast } from '../components/Toast.js';
const empty = (): FavoritesSnapshot => ({ revision: 0, folders: [], stars: [] });
export function useSessionStars(baseUrl: string, enabled: boolean, transport?: RemoteAgentTransport) {
  const service = useMemo(() => new SessionStarsClient(baseUrl), [baseUrl]);
  const [snapshot, setSnapshot] = useState<FavoritesSnapshot>(empty);
  const [confirmedScope, setConfirmedScope] = useState<string>();
  const [loading, setLoading] = useState(enabled);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const latest = useRef(snapshot);
  const generation = useRef(0);
  const busy = useRef(false);
  const requestController = useRef<AbortController>();
  const publish = (value: FavoritesSnapshot) => { latest.current = value; setSnapshot(value); setConfirmedScope(baseUrl); };
  const refresh = useCallback(async () => {
    if (!enabled || busy.current) return;
    const request = ++generation.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setLoading(true);
    try { const value = await service.snapshot(controller.signal); if (generation.current === request) { publish(value); setError(undefined); } }
    catch (error) { if (generation.current === request) setError(error instanceof Error ? error.message : 'Favorites could not be loaded.'); }
    finally { if (generation.current === request) setLoading(false); }
  }, [service, enabled]);
  useEffect(() => { publish(empty()); setConfirmedScope(undefined); }, [service]);
  useEffect(() => {
    setError(undefined); setPending(undefined); busy.current = false; setLoading(enabled);
    void refresh();
    const unwatch = watchPageResume(() => void refresh());
    return () => { ++generation.current; requestController.current?.abort(); unwatch(); };
  }, [refresh, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = transport?.onSessionTitle?.(session => {
      const key = sessionKey(session);
      const previous = latest.current;
      if (!previous.stars.some(star => sessionKey(star) === key && star.title !== session.title)) return;
      publish({ ...previous, stars: previous.stars.map(star => sessionKey(star) === key ? { ...star, title: session.title } : star) });
      clearTimeout(timer); timer = setTimeout(() => void refresh(), 100);
    });
    return () => { remove?.(); clearTimeout(timer); };
  }, [enabled, transport, refresh]);
  async function change(command: FavoriteChange): Promise<boolean> {
    if (!enabled || busy.current || loading) return false;
    busy.current = true;
    const request = ++generation.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setPending('id' in command ? command.id : command.type); setError(undefined);
    try {
      const value = await service.command({ ...command, revision: latest.current.revision }, controller.signal);
      if (request !== generation.current) return false;
      publish(value); return true;
    } catch (error) {
      if (request === generation.current) {
        setError(error instanceof Error ? error.message : 'The favorite change could not be confirmed. Refresh and try again.');
        if (error instanceof FavoritesConflict) {
          try { const value = await service.snapshot(controller.signal); if (request === generation.current) publish(value); }
          catch { /* Keep the last confirmed tree and the original failure visible. */ }
        }
      }
      return false;
    } finally { if (request === generation.current) { busy.current = false; setPending(undefined); setLoading(false); } }
  }
  async function toggle(item: StarInput): Promise<void> {
    const exists = latest.current.stars.some(star => sessionKey(star) === sessionKey(item));
    const { hostId, providerId, nativeSessionId } = item;
    await change(exists ? { type: 'remove-session', session: { hostId, providerId, nativeSessionId } } : { type: 'save-session', session: item, folderId: null });
  }
  useFeedbackToast('Favorites', error);
  return { enabled, scope: baseUrl, ready: enabled && confirmedScope === baseUrl && !loading && !pending && !error, ...snapshot, loading, pending, error, refresh, toggle, change };
}
export type SessionStars = ReturnType<typeof useSessionStars>;
