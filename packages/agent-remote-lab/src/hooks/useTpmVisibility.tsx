import { createContext, useCallback, useEffect, useState } from 'react';
import type { AgentCommand, AgentCommandResult } from '@orchardworks/agent-remote-protocol';

export const TpmViewCommand = { id: 'console:tpm', name: 'tpm', kind: 'command', description: 'Toggle TPM view; use /tpm on or /tpm off', inputHint: '[on|off]' } satisfies AgentCommand;
export const TpmViewScope = createContext<((args: string) => Promise<AgentCommandResult>) | undefined>(undefined);
const key = 'agent-remote:tpm-view';
function preference(): boolean | undefined {
  try { const value = window.localStorage.getItem(key); return value === 'true' ? true : value === 'false' ? false : undefined; }
  catch { return undefined; }
}

/** Presentation preference never controls Controller work lifetime. */
export function useTpmVisibility() {
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
    if (!['', 'on', 'off', 'enable', 'disable'].includes(arg)) throw new Error('Use /tpm, /tpm on, or /tpm off.');
    const next = arg ? arg === 'on' || arg === 'enable' : !visible;
    setVisible(next);
    return { text: `TPM view ${next ? 'shown' : 'hidden'}.` };
  }, [visible, setVisible]);
  const controls = <label><span>TPM view</span><input aria-label="TPM view" type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /></label>;
  return { visible, setVisible, execute, controls };
}
