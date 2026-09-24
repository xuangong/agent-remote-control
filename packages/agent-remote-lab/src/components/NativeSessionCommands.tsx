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

export function NativeSessionCommand({ providerId, nativeSessionId }: { providerId: string; nativeSessionId: string }) {
  // Native session IDs are UUIDs. Never interpolate arbitrary catalog text into shell commands.
  if (!['codex', 'copilot'].includes(providerId) || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(nativeSessionId)) return null;
  return <section className="lab-native-session-command" aria-label="Resume locally">
    <h3>Resume locally</h3>
    <p>{providerId === 'codex' ? 'Run on the Host computer using its Controller configuration. The Controller supplies the socket automatically.' : 'Run on the Host computer using the same Copilot profile. The native CLI prompts if this session is already in use; concurrent clients do not share live updates.'}</p>
    <CopyCommand key={nativeSessionId} label="Terminal command" action="Copy resume command"
      command={`agent-remote-controller ${providerId} resume ${nativeSessionId}`} />
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
