import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureStatus } from '../src/live-recording.js';
import { RecordingPicker, type OpenedRecording } from './recording-picker.js';

export function useLiveRecording() {
  const [status, setStatus] = useState<CaptureStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (changing.current) return;
    const version = revision.current;
    try {
      const response = await fetch('/__ardb/recording', { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Recording status is unavailable.');
      if (mounted.current && version === revision.current) { setStatus(data); setError(undefined); }
    } catch (error) {
      if (mounted.current && version === revision.current) setError(error instanceof Error ? error.message : 'Recording status is unavailable.');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; revision.current++; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  async function change(action: 'start' | 'stop') {
    if (changing.current) return;
    if (action === 'start' && status?.phase === 'stopped' && !window.confirm('Start a new recording? The previous recording will be replaced. Export it first if you want to keep it.')) return;
    changing.current = true; revision.current++; setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/__ardb/recording/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'start' ? { previousId: status?.id } : { id: status?.id }), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Recording request failed.');
      if (mounted.current) setStatus(data);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Recording request failed.'); }
    finally { changing.current = false; if (mounted.current) setBusy(false); }
  }
  return { status, error, busy, change };
}

export function LiveControls({ capture, agentId, onOpen }: {
  capture: ReturnType<typeof useLiveRecording>; agentId: string; onOpen?: (recording: OpenedRecording) => void;
}) {
  const { status, busy, error, change } = capture;
  const active = status?.phase === 'recording' || status?.phase === 'starting';
  const command = `ardb observe ${agentId} --relay ${location.origin} --origin ${location.origin} --jsonl`;
  const [copyError, setCopyError] = useState(false);
  return <section className="ardb-live-controls" aria-label="Live session recording">
    <div className="ardb-live-actions">
      <button type="button" disabled={busy || !status || status.phase === 'starting'} onClick={() => void change(active ? 'stop' : 'start')}>{busy ? 'Please wait…' : active ? 'Stop recording' : 'Record'}</button>
      {status?.phase === 'stopped' ? <a className="ardb-open" href={`/__ardb/recording/export?id=${encodeURIComponent(status.id!)}`} download>Export JSONL</a> : null}
      {onOpen ? <RecordingPicker onOpen={onOpen} /> : null}
    </div>
    <p role="status">{status?.phase === 'recording' ? `Recording · ${Math.round((Date.now() - Date.parse(status.startedAt!)) / 1000)}s · ${status.records} events`
      : status?.phase === 'stopped' ? `Ready to export · ${status.records} events` : status?.phase === 'starting' ? 'Connecting recorder…' : 'Record this shared session, including browser and CLI actions.'}</p>
    {status?.phase === 'stopped' ? <p>Export before starting another recording or closing ARDB.</p> : null}
    {error || status?.error ? <p role="alert" className="ardb-file-error">{error ?? status?.error}</p> : null}
    <details className="ardb-agent-connection"><summary>Connect an AI or CLI client</summary>
      <p>Give this command to your AI agent to watch the same session. It can use send, settings and interaction commands with the same session ID and Relay.</p>
      <code>{command}</code>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopyError(false), () => setCopyError(true)); }}>Copy observer command</button>
      {copyError ? <p role="alert">Select and copy the command above.</p> : null}
    </details>
  </section>;
}
