import { useEffect, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import { runsInstalled } from '../../kernel/installed-app.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

function displayState() {
  return {
    fullscreen: document.fullscreenElement !== null && document.fullscreenElement !== undefined,
    supported: document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function',
    standalone: runsInstalled(),
  };
}

export function MobileDisplaySettings() {
  const t = useTranslate();
  const [display, setDisplay] = useState(displayState);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)');
    const update = () => setDisplay(displayState());
    document.addEventListener('fullscreenchange', update);
    standalone?.addEventListener('change', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      standalone?.removeEventListener('change', update);
    };
  }, []);

  async function toggleFullscreen() {
    if (busy) return;
    setBusy(true); setFailure(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      setDisplay(displayState());
    } catch { setFailure(true); }
    finally { setBusy(false); }
  }

  // Full screen, or why there is none; then how to open Orchard without the address bar, unless it already is.
  return <SettingsSection title={t('settings.display.title')}>
    {display.fullscreen || display.supported && !display.standalone
      ? <SettingsRow label={t('settings.display.fullScreen')} hint={t('settings.display.fullScreenNote')}>
        <Pill disabled={busy} onClick={() => void toggleFullscreen()}>{display.fullscreen ? t('settings.display.exitFullScreen') : t('settings.display.enterFullScreen')}</Pill>
      </SettingsRow>
      : <SettingsRow label={t('settings.display.fullScreen')} hint={display.standalone ? t('settings.display.standalone') : t('settings.display.unsupported')} />}
    {failure ? <p className="lab-setting-note" role="alert">{t('settings.display.failed')}</p> : null}
    {!display.standalone ? <details className="lab-setting-disclosure">
      <summary>{t('settings.display.withoutAddressBar')}</summary>
      <p className="lab-setting-note">{t('settings.display.iphone')}</p>
      <p className="lab-setting-note">{t('settings.display.android')}</p>
    </details> : null}
  </SettingsSection>;
}
