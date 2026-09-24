import { useState } from 'react';
import type { OpenedSession } from '../../agent-remote-lab/src/directory-client.js';

export function ModeControls({ mode, onMode, onClear, session, directory, executable, onStarted }: {
  mode: 'live' | 'replay'; onMode(mode: 'live' | 'replay'): void; onClear(): void; session?: OpenedSession;
  directory: string; executable?: string; onStarted(session: OpenedSession): void;
}) {
  const [provider, setProvider] = useState('codex');
  const [cwd, setCwd] = useState(directory);
  const [binary, setBinary] = useState(executable ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function start() {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch('/__ardb/live/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, cwd, executable: binary || undefined }), signal: AbortSignal.timeout(120000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Cannot start live session.');
      onStarted(data);
    } catch (error) { setError(error instanceof Error ? error.message : 'Cannot start live session.'); }
    finally { setBusy(false); }
  }
  return <section className="ardb-mode-controls" aria-label="Session View mode">
    <div className="ardb-mode-switch" role="group" aria-label="View mode">
      <button type="button" aria-pressed={mode === 'live'} onClick={() => onMode('live')}>Live</button>
      <button type="button" aria-pressed={mode === 'replay'} onClick={() => onMode('replay')}>Replay</button>
      <button type="button" title="Clear the loaded recording and view. The live session keeps running." onClick={onClear}>Clear view</button>
    </div>
    {mode === 'live' && !session ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>Provider<select value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
        <option value="codex">Codex</option><option value="claude">Claude</option><option value="copilot">Copilot</option>
      </select></label>
      <label>Working directory<input value={cwd} required disabled={busy} onChange={event => setCwd(event.target.value)} /></label>
      <details><summary>Executable (optional)</summary><input aria-label="Provider executable" placeholder="Use server PATH" value={binary} disabled={busy} onChange={event => setBinary(event.target.value)} /></details>
      <button type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start live session'}</button>
      <p>Runs on the ARDB server. Switching to Replay keeps this session running.</p>
    </form> : null}
    {session ? <p>{session.providerId} · Live session retained</p> : null}
    {error ? <p role="alert" className="ardb-file-error">{error}</p> : null}
  </section>;
}
