import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useId, useState, useSyncExternalStore } from 'react';
import { clearLayoutDiagnostics, exportLayoutDiagnostics, getLayoutDiagnosticsStatus, startLayoutDiagnostics, stopLayoutDiagnostics, subscribeLayoutDiagnostics } from '../../kernel/layout-diagnostics.js';

export function LayoutDiagnosticsSettings() {
  const t = useTranslate();
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
    try { await navigator.clipboard.writeText(text); setMessage(t('settings.diagnostics.copied')); }
    catch { setMessage(t('settings.diagnostics.copyManually')); }
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
      setMessage(t('settings.diagnostics.prepared'));
    } catch { setMessage(t('settings.diagnostics.downloadUnavailable')); }
  }
  return <div className="lab-display-settings lab-layout-diagnostics">
    <h2>{t('settings.diagnostics.title')}</h2>
    <div className="lab-cache-setting">
      <span id={label}>{t('settings.diagnostics.record')}</span>
      <button type="button" role="switch" aria-checked={state.recording} aria-labelledby={label} aria-describedby={description} disabled={copying} onClick={toggle}><span aria-hidden="true" /></button>
    </div>
    <p id={description}>{state.recording
      ? t('settings.diagnostics.recording')
      : t('settings.diagnostics.idle')}</p>
    <p className="lab-layout-diagnostics-note">{t('settings.diagnostics.note')}</p>
    {state.stopReason === 'timeout' ? <p>{t('settings.diagnostics.timeout')}</p> : null}
    {state.hasRecording ? <div className="lab-layout-diagnostics-actions">
      <button type="button" disabled={copying} onClick={() => void copy()}>{copying ? t('settings.diagnostics.copying') : t('settings.diagnostics.copy')}</button>
      <button type="button" disabled={copying} onClick={download}>{t('settings.diagnostics.download')}</button>
      <button type="button" disabled={copying} onClick={() => { clearLayoutDiagnostics(); setReport(undefined); setMessage(''); }}>{t('settings.diagnostics.clear')}</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {report ? <label className="lab-layout-diagnostics-output">{t('settings.diagnostics.reportText')}
      <textarea readOnly value={report} rows={5} spellCheck={false} onFocus={event => event.currentTarget.select()} />
    </label> : null}
  </div>;
}
