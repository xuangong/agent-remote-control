import { useState } from 'react';

function CopyCommand({ command, label, action }: { command: string; label: string; action: string }) {
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(command); setFailed(false); }
    catch { setFailed(true); setCopied(undefined); }
  }
  return <div className="lab-native-command">
    <label>{label}<input readOnly value={command} onFocus={event => event.currentTarget.select()} /></label>
    <button type="button" onClick={() => void copy()}>{copied === command ? 'Copied' : action}</button>
    {failed ? <p role="alert">Copy failed. Select and copy the command above.</p> : null}
  </div>;
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const attachableIds: Readonly<Record<string, RegExp>> = { codex: uuid, copilot: uuid, claude: uuid, opencode: /^ses_[A-Za-z\d]+$/ };
const attachNotes: Readonly<Record<string, string>> = {
  codex: 'Run on the Host computer using its Controller configuration. The Controller supplies the shared daemon automatically.',
  copilot: 'Run on the Host computer using the same Copilot profile. If another client controls this session, the command offers to take it over.',
  claude: 'Run on the Host computer using the same Claude profile. If this session is open here, the command asks before interrupting it and taking control.',
  opencode: 'Run on the Host computer. It attaches to the shared OpenCode server; this session stays open here.',
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
  const command = nativeOpenCommand({ hostId, providerId, nativeSessionId }, workspace);
  if (!command) return null;
  return <section className="lab-native-session-command" aria-label="Open on Host">
    <h3>Open on Host</h3>
    <p>{attachNotes[providerId]}{command.startsWith('agent-remote-controller ') ? ' Run it from the session’s working directory.' : ''}</p>
    <CopyCommand key={nativeSessionId} label="Terminal command" action="Copy command" command={command} />
  </section>;
}

export function NativeDaemonRecovery() {
  return <details className="lab-native-daemon-recovery">
    <summary>Restart daemon to recover…</summary>
    <p>Restarting disconnects all sessions using this shared Codex daemon. Running responses and tools may be interrupted. Saved history remains, but unfinished work may need checking; unconfirmed messages will not be resent automatically.</p>
    <p>Check active work first. If you choose to restart, run this on the Host computer using the same Controller configuration. Copying does not execute it.</p>
    <CopyCommand label="Restart command" action="Copy restart command" command="agent-remote-controller codex daemon restart" />
    <p>If the problem returns, check the daemon’s file descriptor usage and limit. The Controller starts the replacement with a limit of 8192 unless configured otherwise.</p>
  </details>;
}
