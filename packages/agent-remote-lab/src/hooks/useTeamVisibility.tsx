import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommand, AgentCommandResult } from '@orchardworks/agent-remote-protocol';

export const TeamViewCommand = { id: 'console:team', name: 'team', kind: 'command', description: 'Toggle Team view; use /team on or /team off', inputHint: '[on|off]' } satisfies AgentCommand;
export const TeamViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
const key = 'agent-remote:team-view';
function preference(): boolean {
  try { return window.localStorage.getItem(key) !== 'false'; }
  catch { return true; }
}

/** Hiding Team presentation never changes membership or Controller work lifetime. */
export function useTeamVisibility() {
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
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error('Use /team, /team on, or /team off.');
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: `Team view ${next ? 'shown' : 'hidden'}.` };
  }, [visible, setVisible]);
  const controls = <label><span>Team view</span><input aria-label="Team view" type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
