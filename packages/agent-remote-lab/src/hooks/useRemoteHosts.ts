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
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await service.hosts();
        if (!retired) { setHosts(result.hosts); setError(undefined); }
      } catch (reason) { if (!retired) setError(reason instanceof Error ? reason.message : 'Could not load Hosts.'); }
      finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { retired = true; window.clearInterval(timer); };
  }, [service, enabled, generation]);
  return { hosts, error, retry };
}
