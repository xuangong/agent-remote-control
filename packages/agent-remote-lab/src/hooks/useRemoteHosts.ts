import { watchFeedRefresh } from '@orchardworks/agent-client';
import { useCallback, useEffect, useState } from 'react';
import type { HostPairingService, RemoteHost } from '../components/HostPairing.js';

export function useRemoteHosts(service: HostPairingService, enabled: boolean, discovery = true, activeHostId?: string) {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  /** Until the first list arrives, an empty list does not mean a Host is missing. */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let retired = false;
    let inFlight = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offline = false;
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const current = ++request;
      try {
        const result = await service.hosts();
        offline = !!activeHostId && activeHostId !== 'local' && result.hosts.find(host => host.id === activeHostId)?.online !== true;
        if (!retired && request === current) { setHosts(previous => JSON.stringify(previous) === JSON.stringify(result.hosts) ? previous : result.hosts); setLoaded(true); setError(undefined); }
      } catch (reason) { if (!retired && request === current) setError(reason instanceof Error ? reason.message : 'Could not load Hosts.'); }
      finally {
        if (request === current) inFlight = false;
        clearTimeout(timer);
        if (!retired) timer = setTimeout(() => void load(), discovery || offline ? 5000 : 30000);
      }
    };
    // A hidden page stops the interval. Becoming visible starts it again and loads nothing; a reopened feed loads at once.
    const visible = () => {
      if (document.visibilityState === 'hidden' || inFlight || retired) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), discovery || offline ? 5000 : 30000);
    };
    document.addEventListener('visibilitychange', visible);
    const unwatch = watchFeedRefresh(() => void load());
    void load();
    return () => { retired = true; unwatch(); document.removeEventListener('visibilitychange', visible); clearTimeout(timer); };
  }, [service, enabled, generation, discovery, activeHostId]);
  return { hosts, loaded, error, retry };
}
