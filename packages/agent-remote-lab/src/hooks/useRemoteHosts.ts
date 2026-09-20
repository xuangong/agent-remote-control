import { watchPageResume } from '@agent-remote-controller/agent-remote-web';
import { useCallback, useEffect, useState } from 'react';
import type { HostPairingService, RemoteHost } from '../components/HostPairing.js';

export function useRemoteHosts(service: HostPairingService, enabled: boolean) {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let retired = false;
    let inFlight = false;
    let request = 0;
    const load = async (force = false) => {
      if ((!force && inFlight) || document.visibilityState === 'hidden') return;
      inFlight = true;
      const current = ++request;
      try {
        const result = await service.hosts();
        if (!retired && request === current) { setHosts(previous => JSON.stringify(previous) === JSON.stringify(result.hosts) ? previous : result.hosts); setError(undefined); }
      } catch (reason) { if (!retired && request === current) setError(reason instanceof Error ? reason.message : 'Could not load Hosts.'); }
      finally { if (request === current) inFlight = false; }
    };
    const unwatch = watchPageResume(() => void load(true));
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { retired = true; unwatch(); window.clearInterval(timer); };
  }, [service, enabled, generation]);
  return { hosts, error, retry };
}
