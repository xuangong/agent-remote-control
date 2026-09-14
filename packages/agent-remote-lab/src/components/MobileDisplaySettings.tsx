import { useEffect, useState } from 'react';

function displayState() {
  return {
    fullscreen: document.fullscreenElement !== null && document.fullscreenElement !== undefined,
    supported: document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function',
    standalone: window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

export function MobileDisplaySettings() {
  const [display, setDisplay] = useState(displayState);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)');
    const update = () => setDisplay(displayState());
    document.addEventListener('fullscreenchange', update);
    standalone.addEventListener('change', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      standalone.removeEventListener('change', update);
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
    <h2>Display</h2>
    {display.fullscreen || display.supported && !display.standalone ? <>
      <button type="button" disabled={busy} onClick={() => void toggleFullscreen()}>{display.fullscreen ? 'Exit full screen' : 'Enter full screen'}</button>
      <p>Hide the browser controls while you work. Your browser may leave full screen when you switch apps or use the keyboard.</p>
    </> : display.standalone ? <p>Opened from your Home Screen, without the browser address bar.</p>
      : <p>This browser does not support page full screen.</p>}
    {failure ? <p role="alert">Full screen could not be changed. Try again, or open Agent Remote from your Home Screen.</p> : null}
    {!display.standalone ? <details>
      <summary>Open without the address bar</summary>
      <p>On iPhone, use Safari: Share → Add to Home Screen. Enable Open as Web App if shown, then open the saved icon.</p>
      <p>On Android, use your browser menu to install the app or add it to your Home Screen, then open the saved icon.</p>
    </details> : null}
  </div>;
}
