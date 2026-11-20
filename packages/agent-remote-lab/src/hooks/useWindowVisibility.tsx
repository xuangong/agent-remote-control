import { useCallback, useEffect, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

const key = 'agent-remote:window-view';
function preference(): boolean {
  try { return window.localStorage.getItem(key) !== 'false'; }
  catch { return true; }
}

export function useWindowVisibility() {
  const t = useTranslate();
  const [visible, setChoice] = useState(preference);
  useEffect(() => {
    const refresh = () => setChoice(preference());
    window.addEventListener('storage', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const setVisible = useCallback((value: boolean) => {
    try { window.localStorage.setItem(key, String(value)); } catch { /* The current page can still change visibility. */ }
    setChoice(value);
  }, []);
  const controls = <label><span>{t('windows.windowView')}</span><input aria-label={t('windows.windowView')} type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, controls };
}
