import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { watchPageResume } from '@agent-remote-controller/agent-remote-web';
import { SessionStarsClient, type StarInput, type VisibleSessionStar } from '../session-stars-client.js';
import { sessionKey } from '../session-tree.js';
import { useFeedbackToast } from '../components/Toast.js';

export function useSessionStars(baseUrl: string, enabled: boolean) {
  const service = useMemo(() => new SessionStarsClient(baseUrl), [baseUrl]);
  const [stars, setStars] = useState<VisibleSessionStar[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const busy = useRef(false);
  const requestController = useRef<AbortController>();
  const refresh = useCallback(async () => {
    if (!enabled || busy.current) return;
    const request = ++generation.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setLoading(true);
    try { const value = await service.list(controller.signal); if (generation.current === request) { setStars(value); setError(undefined); } }
    catch (error) { if (generation.current === request) setError(error instanceof Error ? error.message : 'Favorites could not be loaded.'); }
    finally { if (generation.current === request) setLoading(false); }
  }, [service, enabled]);
  useEffect(() => {
    setStars([]); setError(undefined); setPending(undefined); busy.current = false;
    void refresh();
    const unwatch = watchPageResume(() => void refresh());
    return () => { ++generation.current; requestController.current?.abort(); unwatch(); };
  }, [refresh]);
  async function toggle(item: StarInput): Promise<void> {
    if (!enabled || busy.current) return;
    busy.current = true;
    const request = ++generation.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    setPending(sessionKey(item)); setError(undefined);
    try {
      const exists = stars.some(star => sessionKey(star) === sessionKey(item));
      const value = await (exists ? service.remove(item, controller.signal) : service.save(item, controller.signal));
      if (request === generation.current) setStars(value);
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : 'The favorite change could not be confirmed. Refresh and try again.'); }
    finally { if (request === generation.current) { busy.current = false; setPending(undefined); setLoading(false); } }
  }
  useFeedbackToast('Favorites', error);
  return { enabled, stars, loading, pending, error, refresh, toggle };
}
export type SessionStars = ReturnType<typeof useSessionStars>;
