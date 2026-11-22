import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import type { ConsoleCommand } from '@orchardworks/agent-client-web/react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export const TeamViewCommand = { id: 'console:team', name: 'team', kind: 'command', description: 'Toggle Team view; use /team on or /team off', inputHint: '[on|off]', descriptionKey: 'team.console.team' } satisfies ConsoleCommand;
export const TeamViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
const key = 'agent-remote:team-view';
function preference(): boolean {
  try { return window.localStorage.getItem(key) !== 'false'; }
  catch { return true; }
}

/** The Team preference controls its management entry, never session placement or work lifetime. */
export function useTeamVisibility() {
  const t = useTranslate();
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
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error(t('team.team.command.usage'));
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: next ? t('team.team.command.shown') : t('team.team.command.hidden') };
  }, [visible, setVisible, t]);
  const controls = <label><span>{t('team.team.view')}</span><input aria-label={t('team.team.view')} type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
