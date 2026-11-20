import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export const AskViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
export const AskViewCommand = { id: 'console:ask', name: 'ask', kind: 'command' as const, description: 'Toggle global Ask view; use on/off', descriptionKey: 'team.console.ask' as const };
const key = 'agent-remote:ask-view';
function preference(): boolean {
  try { return window.localStorage.getItem(key) === 'true'; }
  catch { return false; }
}

/** Presentation preference never controls the source-bound Ask session lifetime. */
export function useAskVisibility() {
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
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error(t('team.ask.command.usage'));
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: next ? t('team.ask.command.shown') : t('team.ask.command.hidden') };
  }, [visible, setVisible, t]);
  const controls = <label><span>{t('team.ask.view')}</span><input aria-label={t('team.ask.view')} type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
