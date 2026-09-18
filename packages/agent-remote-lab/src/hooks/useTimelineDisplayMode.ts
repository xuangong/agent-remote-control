import { useEffect, useState } from 'react';
import type { TimelineDisplayMode } from '@agent-remote-controller/agent-remote-web/react';

const key = 'agent-remote:timeline-display';
export function useTimelineDisplayMode() {
  const [mode, setMode] = useState<TimelineDisplayMode>(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved === 'simple' || saved === 'content' ? saved : 'preview';
    }
    catch { return 'preview'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, mode); }
    catch { /* Display preferences remain usable when browser storage is unavailable. */ }
  }, [mode]);
  return [mode, setMode] as const;
}
