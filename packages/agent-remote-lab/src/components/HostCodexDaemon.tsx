import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CodexDaemonStatus } from '@orchardworks/agent-remote-protocol';
import type { HostPairingService, RemoteHost } from './HostPairing.js';

export function HostCodexDaemon({ host, service, visible = true }: { host: RemoteHost; service: HostPairingService; visible?: boolean }) {
  if (host.access === 'shared' || !host.managed || !service.codexDaemon
    || !host.providers?.some(provider => provider.providerId === 'codex' && provider.daemonControl)) return null;
  return <DaemonControl key={host.id} host={host} request={service.codexDaemon.bind(service)} visible={visible} />;
}

function DaemonControl({ host, request, visible }: {
  host: RemoteHost; request: NonNullable<HostPairingService['codexDaemon']>; visible: boolean;
}) {
  const [status, setStatus] = useState<CodexDaemonStatus>();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const serial = useRef(0), mounted = useRef(true), writing = useRef(false);
  const requestRef = useRef(request); requestRef.current = request;
  const deadline = useRef(Date.now() + 120000);
  const description = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (!host.online || !visible || writing.current) return;
    const ticket = ++serial.current; setChecking(true);
    try {
      const result = await requestRef.current(host.id);
      if (!mounted.current || ticket !== serial.current) return;
      setStatus(result); setFailure(undefined); setUncertain(false);
    } catch (error) {
      if (mounted.current && ticket === serial.current) setFailure(error instanceof Error ? error.message : 'Could not check daemon status.');
    } finally {
      if (mounted.current && ticket === serial.current) setChecking(false);
    }
  }, [host.id, host.online, visible]);
  useEffect(() => {
    if (!document.hidden) void refresh();
    return () => { serial.current++; };
  }, [refresh, refreshKey]);
  useEffect(() => {
    if (!visible || !host.online) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const pending = uncertain || status?.phase === 'restarting';
    const schedule = () => {
      clearTimeout(timer);
      if (disposed || !pending || document.hidden || Date.now() > deadline.current) return;
      timer = setTimeout(async () => { await refresh(); schedule(); }, failure ? 5000 : 1500);
    };
    const onVisibility = () => {
      if (!document.hidden) { deadline.current = Date.now() + 120000; void refresh(); }
      schedule();
    };
    schedule(); document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh, visible, host.online, status?.phase, uncertain, failure]);
  async function restart() {
    if (!status || writing.current || !host.online || uncertain || status.phase === 'restarting') return;
    writing.current = true; const ticket = ++serial.current;
    setSubmitting(true); setChecking(false); setFailure(undefined);
    try {
      const result = await requestRef.current(host.id, { operationId: crypto.randomUUID(), revision: status.revision });
      if (mounted.current && ticket === serial.current) { setStatus(result); setUncertain(false); }
    } catch (error) {
      if (mounted.current && ticket === serial.current) {
        setUncertain(true);
        setFailure(`${error instanceof Error ? error.message : 'The restart was not confirmed.'} Checking status without sending another restart.`);
      }
    } finally {
      writing.current = false;
      if (mounted.current) {
        setSubmitting(false); setConfirming(false); deadline.current = Date.now() + 120000;
        setRefreshKey(value => value + 1);
      }
    }
  }
  const busy = submitting || status?.phase === 'restarting';
  const labels: Record<string, string> = {
    restarting: 'Restarting Codex daemon…', ready: 'Restart completed. Codex daemon confirmed ready. Interrupted tasks do not resume automatically.',
    failed: 'Restart failed. Check the local daemon before trying again.',
    unknown: 'Restart outcome unknown. Inspect native state before restarting again.',
  };
  return <div className="lab-host-codex-daemon">
    <div className="lab-host-security-actions">
      <button type="button" disabled={!host.online || busy || checking || uncertain || !status} onClick={() => { setConfirming(true); void refresh(); }}>Restart Codex daemon</button>
      <button type="button" disabled={!host.online || submitting || checking} onClick={() => { deadline.current = Date.now() + 120000; void refresh(); }}>Check status</button>
    </div>
    {confirming ? <div className="gateway-security-confirmation" role="group" aria-label="Confirm Codex daemon restart" aria-describedby={description}>
      <p id={description}>Restart the shared Codex daemon on {host.name}? All its Codex sessions, including local CLI sessions, will disconnect. Running tasks will be interrupted and will not resume automatically. Saved history is preserved.</p>
      <button type="button" disabled={busy || checking || uncertain || !host.online} onClick={() => void restart()}>Confirm restart</button>
      <button type="button" disabled={submitting} onClick={() => setConfirming(false)}>Cancel</button>
    </div> : null}
    {!host.online ? <p role="status">Host offline. Reconnect to check daemon status.</p>
      : submitting || status?.phase && status.phase !== 'idle' ? <p role="status">{submitting ? 'Requesting daemon restart…' : labels[status!.phase]}</p> : null}
    {failure ? <p role="alert">{failure}</p> : null}
  </div>;
}
