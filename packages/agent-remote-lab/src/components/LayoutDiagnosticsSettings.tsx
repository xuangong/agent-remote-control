import { useId, useState, useSyncExternalStore } from 'react';
import { clearLayoutDiagnostics, exportLayoutDiagnostics, getLayoutDiagnosticsStatus, startLayoutDiagnostics, stopLayoutDiagnostics, subscribeLayoutDiagnostics } from '../layout-diagnostics.js';

export function LayoutDiagnosticsSettings() {
  const state = useSyncExternalStore(subscribeLayoutDiagnostics, getLayoutDiagnosticsStatus, getLayoutDiagnosticsStatus);
  const label = useId(), description = useId();
  const [report, setReport] = useState<string>();
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  function toggle() {
    setMessage(''); setReport(undefined);
    if (state.recording) stopLayoutDiagnostics();
    else startLayoutDiagnostics();
  }
  function snapshot() {
    stopLayoutDiagnostics();
    const text = exportLayoutDiagnostics();
    setReport(text);
    return text;
  }
  async function copy() {
    const text = snapshot();
    setCopying(true);
    try { await navigator.clipboard.writeText(text); setMessage('Copied. Paste the report into your conversation.'); }
    catch { setMessage('Select and copy the report below, or download it.'); }
    finally { setCopying(false); }
  }
  function download() {
    const text = snapshot();
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `arc-layout-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage('Report prepared. You can also copy the text below.');
    } catch { setMessage('Download unavailable. Select and copy the report below.'); }
  }
  return <div className="lab-display-settings lab-layout-diagnostics">
    <h2>Layout diagnostics</h2>
    <div className="lab-cache-setting">
      <span id={label}>Record layout changes</span>
      <button type="button" role="switch" aria-checked={state.recording} aria-labelledby={label} aria-describedby={description} disabled={copying} onClick={toggle}><span aria-hidden="true" /></button>
    </div>
    <p id={description}>{state.recording
      ? 'Recording. Return to your conversation and rotate your device. Then come back here to copy the report. Stops after 10 minutes.'
      : 'Capture screen, keyboard and layout positions to investigate jumps. No chat text, drafts or credentials are recorded.'}</p>
    <p className="lab-layout-diagnostics-note">Kept only in this page. Refreshing loses the report. Starting again replaces it. Recording may briefly affect performance.</p>
    {state.stopReason === 'timeout' ? <p>Recording stopped after 10 minutes. Your report is ready.</p> : null}
    {state.hasRecording ? <div className="lab-layout-diagnostics-actions">
      <button type="button" disabled={copying} onClick={() => void copy()}>{copying ? 'Copying…' : 'Copy report'}</button>
      <button type="button" disabled={copying} onClick={download}>Download</button>
      <button type="button" disabled={copying} onClick={() => { clearLayoutDiagnostics(); setReport(undefined); setMessage(''); }}>Clear report</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {report ? <label className="lab-layout-diagnostics-output">Report text
      <textarea readOnly value={report} rows={5} spellCheck={false} onFocus={event => event.currentTarget.select()} />
    </label> : null}
  </div>;
}
