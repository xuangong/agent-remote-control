import { useEffect, useState } from 'react';

const key = 'agent-remote:show-letters';

export function useTimelineLettersVisible() {
  const [visible, setVisible] = useState(() => {
    try { return window.localStorage.getItem(key) !== 'false'; }
    catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, String(visible)); }
    catch { /* Display preferences remain usable when browser storage is unavailable. */ }
  }, [visible]);
  return [visible, setVisible] as const;
}
