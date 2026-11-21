import { useEffect, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { runsInstalled } from '../installed-app.js';

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

  return <div className="lab-display-settings">
    <h2>{t('settings.display.title')}</h2>
    {display.fullscreen || display.supported && !display.standalone ? <>
      <button type="button" disabled={busy} onClick={() => void toggleFullscreen()}>{display.fullscreen ? t('settings.display.exitFullScreen') : t('settings.display.enterFullScreen')}</button>
      <p>{t('settings.display.fullScreenNote')}</p>
    </> : display.standalone ? <p>{t('settings.display.standalone')}</p>
      : <p>{t('settings.display.unsupported')}</p>}
    {failure ? <p role="alert">{t('settings.display.failed')}</p> : null}
    {!display.standalone ? <details>
      <summary>{t('settings.display.withoutAddressBar')}</summary>
      <p>{t('settings.display.iphone')}</p>
      <p>{t('settings.display.android')}</p>
    </details> : null}
  </div>;
}
