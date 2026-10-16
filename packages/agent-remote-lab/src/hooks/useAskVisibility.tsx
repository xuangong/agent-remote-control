import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';

export const AskViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
export const AskViewCommand = { id: 'console:ask', name: 'ask', kind: 'command' as const, description: 'Toggle global Ask view; use on/off' };
const key = 'agent-remote:ask-view';
function preference(): boolean {
  try { return window.localStorage.getItem(key) === 'true'; }
  catch { return false; }
}

/** Presentation preference never controls the source-bound Ask session lifetime. */
export function useAskVisibility() {
  const [visible, setChoice] = useState(preference);
  useEffect(() => {
    const refresh = () => setChoice(preference());
    window.addEventListener('storage', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const setVisible = useCallback((value: boolean) => {
    try { window.localStorage.setItem(key, String(value)); } catch { /* Keep the page preference usable without storage. */ }
    setChoice(value);
  }, []);
  const execute = useCallback(async (args: string): Promise<AgentCommandResult> => {
    const arg = args.trim().toLowerCase();
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error('Use /ask, /ask on, or /ask off.');
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: `Ask view ${next ? 'shown' : 'hidden'}.` };
  }, [visible, setVisible]);
  const controls = <label><span>Ask view</span><input aria-label="Ask view" type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
