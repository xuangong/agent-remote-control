import { useState } from 'react';
import type { MessageKey } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';

function CopyCommand({ command, label, action }: { command: string; label: string; action: string }) {
  const t = useTranslate();
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(command); setFailed(false); }
    catch { setFailed(true); setCopied(undefined); }
  }
  return <div className="lab-native-command">
    <label>{label}<input readOnly value={command} onFocus={event => event.currentTarget.select()} /></label>
    <button type="button" onClick={() => void copy()}>{copied === command ? t('common.copied') : action}</button>
    {failed ? <p role="alert">{t('sessions.native.copyFailed')}</p> : null}
  </div>;
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const attachableIds: Readonly<Record<string, RegExp>> = { codex: uuid, copilot: uuid, claude: uuid, opencode: /^ses_[A-Za-z\d]+$/ };
const attachNotes: Readonly<Record<string, MessageKey>> = {
  codex: 'sessions.native.noteCodex',
  copilot: 'sessions.native.noteCopilot',
  claude: 'sessions.native.noteClaude',
  opencode: 'sessions.native.noteOpencode',
};

/** Moves to the session's working directory, then opens it with the Controller's session attach. */
export function nativeOpenCommand({ hostId = 'local', providerId, nativeSessionId }: { hostId?: string; providerId: string; nativeSessionId: string }, workspace?: string): string | undefined {
  // Never interpolate arbitrary catalog text into shell commands: IDs must match the native format, and paths are quoted.
  if (!attachableIds[providerId]?.test(nativeSessionId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(hostId)) return undefined;
  const attach = `agent-remote-controller session attach ${hostId}/${providerId}/${nativeSessionId}`;
  if (!workspace || /[\u0000-\u001f\u007f-\u009f]/.test(workspace)) return attach;
  if (workspace.startsWith('/')) return `cd '${workspace.replaceAll("'", `'\\''`)}' && ${attach}`;
  // Windows terminals default to PowerShell, where every single-quote form ends a literal string unless doubled.
  // Stop keeps a failed directory change from opening elsewhere; Windows PowerShell has no &&.
  if (/^([A-Za-z]:[\\/]|\\\\)/.test(workspace)) return `Set-Location -LiteralPath '${workspace.replace(/['\u2018-\u201b]/g, '$&$&')}' -ErrorAction Stop; ${attach}`;
  return attach;
}

export function NativeSessionCommand({ hostId, providerId, nativeSessionId, workspace }: { hostId?: string; providerId: string; nativeSessionId: string; workspace?: string }) {
  const t = useTranslate();
  const command = nativeOpenCommand({ hostId, providerId, nativeSessionId }, workspace);
  if (!command) return null;
  const note = attachNotes[providerId] ? t(attachNotes[providerId]!) : '';
  return <section className="lab-native-session-command" aria-label={t('sessions.native.openOnHost')}>
    <h3>{t('sessions.native.openOnHost')}</h3>
    <p>{command.startsWith('agent-remote-controller ') ? t('sessions.native.runFromDirectory', { note }) : note}</p>
    <CopyCommand key={nativeSessionId} label={t('sessions.native.terminalCommand')} action={t('sessions.native.copyCommand')} command={command} />
  </section>;
}

export function NativeDaemonRecovery() {
  const t = useTranslate();
  return <details className="lab-native-daemon-recovery">
    <summary>{t('sessions.native.restartSummary')}</summary>
    <p>{t('sessions.native.restartWarning')}</p>
    <p>{t('sessions.native.restartAdvice')}</p>
    <CopyCommand label={t('sessions.native.restartCommand')} action={t('sessions.native.copyRestartCommand')} command="agent-remote-controller codex daemon restart" />
    <p>{t('sessions.native.descriptorAdvice')}</p>
  </details>;
}
