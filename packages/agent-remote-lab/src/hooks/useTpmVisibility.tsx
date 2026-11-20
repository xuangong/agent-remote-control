import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommand, AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export const TpmViewCommand = { id: 'console:tpm', name: 'tpm', kind: 'command', description: 'Toggle TPM view; use /tpm on or /tpm off', inputHint: '[on|off]' } satisfies AgentCommand;
export const TpmViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
const key = 'agent-remote:tpm-view';
function preference(): boolean | undefined {
  try { const value = window.localStorage.getItem(key); return value === 'true' ? true : value === 'false' ? false : undefined; }
  catch { return undefined; }
}

/** Presentation preference never controls Controller work lifetime. */
export function useTpmVisibility() {
  const t = useTranslate();
  const [coarse, setCoarse] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const [choice, setChoice] = useState(preference);
  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    const resize = () => setCoarse(media?.matches ?? false);
    const refresh = () => setChoice(preference());
    media?.addEventListener('change', resize);
    window.addEventListener('storage', refresh); window.addEventListener('focus', refresh);
    return () => { media?.removeEventListener('change', resize); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const visible = choice ?? coarse;
  const setVisible = useCallback((value: boolean) => {
    try { window.localStorage.setItem(key, String(value)); } catch { /* Keep the page preference usable without storage. */ }
    setChoice(value);
  }, []);
  const execute = useCallback(async (args: string): Promise<AgentCommandResult> => {
    const arg = args.trim().toLowerCase();
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error(t('team.tpm.command.usage'));
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: next ? t('team.tpm.command.shown') : t('team.tpm.command.hidden') };
  }, [visible, setVisible, t]);
  const controls = <label><span>{t('team.tpm.view')}</span><input aria-label={t('team.tpm.view')} type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
