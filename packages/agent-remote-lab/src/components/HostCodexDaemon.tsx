import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CodexDaemonStatus } from '@orchardworks/agent-remote-protocol';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { HostPairingService, RemoteHost } from '../kernel/remote-host.js';

// Cover the fifteen-minute native refresh plus readiness confirmation and transport delay.
const daemonStatusPollingWindowMs = 16 * 60000;

export function HostCodexDaemon({ host, service, visible = true }: { host: RemoteHost; service: HostPairingService; visible?: boolean }) {
  if (host.access === 'shared' || !host.managed || !service.codexDaemon
    || !host.providers?.some(provider => provider.providerId === 'codex' && provider.daemonControl)) return null;
  return <DaemonControl key={host.id} host={host} request={service.codexDaemon.bind(service)} visible={visible} />;
}

function DaemonControl({ host, request, visible }: {
  host: RemoteHost; request: NonNullable<HostPairingService['codexDaemon']>; visible: boolean;
}) {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
  const [status, setStatus] = useState<CodexDaemonStatus>();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const serial = useRef(0), mounted = useRef(true), writing = useRef(false);
  const requestRef = useRef(request); requestRef.current = request;
  const deadline = useRef(Date.now() + daemonStatusPollingWindowMs);
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
      if (mounted.current && ticket === serial.current) setFailure(errorWords(error, words.current, 'hosts.daemon.statusFailed'));
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
      if (!document.hidden) deadline.current = Date.now() + daemonStatusPollingWindowMs;
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
        setFailure(t('hosts.daemon.checking', { message: errorWords(error, t, 'hosts.daemon.restartUnconfirmed') }));
      }
    } finally {
      writing.current = false;
      if (mounted.current) {
        setSubmitting(false); setConfirming(false); deadline.current = Date.now() + daemonStatusPollingWindowMs;
        setRefreshKey(value => value + 1);
      }
    }
  }
  const busy = submitting || status?.phase === 'restarting';
  const labels: Record<string, string> = {
    restarting: t('hosts.daemon.restarting'), ready: t('hosts.daemon.ready'),
    failed: status?.message || t('hosts.daemon.failed'),
    unknown: t('hosts.daemon.unknown'),
  };
  return <div className="lab-host-codex-daemon">
    <div className="lab-host-security-actions">
      <button type="button" disabled={!host.online || busy || checking || uncertain || !status} onClick={() => { setConfirming(true); void refresh(); }}>{t('hosts.daemon.restart')}</button>
      <button type="button" disabled={!host.online || submitting || checking} onClick={() => { deadline.current = Date.now() + daemonStatusPollingWindowMs; void refresh(); }}>{t('hosts.daemon.check')}</button>
    </div>
    {confirming ? <div className="gateway-security-confirmation" role="group" aria-label={t('hosts.daemon.confirmLabel')} aria-describedby={description}>
      <p id={description}>{t('hosts.daemon.confirm', { name: host.name })}</p>
      <button type="button" disabled={busy || checking || uncertain || !host.online} onClick={() => void restart()}>{t('hosts.daemon.confirmAction')}</button>
      <button type="button" disabled={submitting} onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
    </div> : null}
    {!host.online ? <p role="status">{t('hosts.daemon.offline')}</p>
      : submitting || status?.phase && status.phase !== 'idle' ? <p role="status">{submitting ? t('hosts.daemon.requesting') : labels[status!.phase]}</p> : null}
    {failure ? <p role="alert">{failure}</p> : null}
  </div>;
}
