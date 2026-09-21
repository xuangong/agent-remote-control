import { watchPageResume } from '@orchardworks/agent-remote-web';
import { useCallback, useEffect, useState } from 'react';
import type { HostPairingService, RemoteHost } from '../components/HostPairing.js';

export function useRemoteHosts(service: HostPairingService, enabled: boolean, discovery = true, activeHostId?: string) {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
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
        if (!retired && request === current) { setHosts(previous => JSON.stringify(previous) === JSON.stringify(result.hosts) ? previous : result.hosts); setError(undefined); }
      } catch (reason) { if (!retired && request === current) setError(reason instanceof Error ? reason.message : 'Could not load Hosts.'); }
      finally {
        if (request === current) inFlight = false;
        clearTimeout(timer);
        if (!retired) timer = setTimeout(() => void load(), discovery || offline ? 5000 : 30000);
      }
    };
    const unwatch = watchPageResume(() => void load());
    void load();
    return () => { retired = true; unwatch(); clearTimeout(timer); };
  }, [service, enabled, generation, discovery, activeHostId]);
  return { hosts, error, retry };
}
