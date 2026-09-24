import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentReplicaState, RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { LabWorkbench, type LabWorkbenchActions } from '../../agent-remote-lab/src/components/LabWorkbench.js';
import { DebugSessionView } from './session-view.js';
import { parseRecording, RecordingPlayer, type SessionRecording } from '../src/recording.js';

const noActions: LabWorkbenchActions = {};
const ReplaySession = memo(function ReplaySession({ state, status }: { state: AgentReplicaState; status: RemoteSessionStatus }) {
  return <LabWorkbench readOnly state={state} sessionStatus={status} actions={noActions} draftSessionKey={`replay:${state.agent?.id}`} />;
});
const time = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}:${(milliseconds / 1000 % 60).toFixed(1).padStart(4, '0')}`;

export function ReplayView({ name: initialName, recording: initialRecording }: { name: string; recording: SessionRecording }) {
  const [{ name, recording, revision }, setRecording] = useState({ name: initialName, recording: initialRecording, revision: 0 });
  const [fileError, setFileError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  async function openFile(file: File | undefined) {
    if (!file) return;
    const request = ++selection.current;
    setLoading(true); setFileError(undefined);
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('Select a JSONL recording no larger than 64 MiB.');
      const next = parseRecording(await file.text());
      if (request === selection.current) {
        setRecording(current => ({ name: file.name, recording: next, revision: current.revision + 1 }));
      }
    } catch (error) {
      if (request === selection.current) setFileError(error instanceof Error ? error.message : 'Unable to open recording.');
    } finally { if (request === selection.current) setLoading(false); }
  }
  useEffect(() => () => { selection.current++; }, []);
  const player = useMemo(() => new RecordingPlayer(recording), [recording]);
  const [, refresh] = useState(0);
  const update = () => refresh(value => value + 1);
  useEffect(() => {
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      if (player.playing) { player.advance(now - previous); update(); }
      previous = now;
    }, 50);
    const onHidden = () => { if (document.hidden) { player.pause(); update(); } previous = performance.now(); };
    document.addEventListener('visibilitychange', onHidden);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onHidden); };
  }, [player]);
  const change = (action: () => void) => { action(); update(); };
  return <DebugSessionView playbackControls={
    <section className="ardb-playback" aria-label="Recording playback">
      <div className="ardb-recording-heading"><div className="ardb-recording-title"><strong title={name}>{name}</strong><span>Session recording · Read only</span></div>
        <button type="button" className="ardb-open" disabled={loading} onClick={() => fileInput.current?.click()}>{loading ? 'Opening…' : 'Open recording'}</button>
        <input ref={fileInput} hidden type="file" accept=".jsonl,.ndjson,application/x-ndjson,application/jsonl" aria-label="Open recording file"
          onChange={event => { void openFile(event.target.files?.[0]); event.target.value = ''; }} />
      </div>
      {fileError ? <p className="ardb-file-error" role="alert">{fileError}</p> : null}
      <div className="ardb-playback-controls">
        <button type="button" className="ardb-play" aria-label={player.playing ? 'Pause recording' : 'Play recording'} onClick={() => change(() => player.playing ? player.pause() : player.play())}>{player.playing ? 'Pause' : 'Play'}</button>
        <button type="button" aria-label="Restart recording" onClick={() => change(() => { player.pause(); player.seek(0); })}>Restart</button>
        <button type="button" aria-label="Next recorded event" disabled={player.position >= recording.duration} onClick={() => change(() => player.step())}>Step</button>
        <select aria-label="Playback speed" value={player.speed} onChange={event => change(() => { player.speed = Number(event.target.value); })}>
          {[0.5, 1, 2, 4].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
        </select>
        <output aria-label="Playback time">{time(player.position)} / {time(recording.duration)}</output>
      </div>
      <input type="range" aria-label="Playback position" min="0" max={recording.duration} step="1" value={player.position}
        aria-valuetext={`${time(player.position)} of ${time(recording.duration)}`} onChange={event => change(() => { player.pause(); player.seek(Number(event.target.value)); })} />
      {recording.warnings.length > 0 ? <details className="ardb-recording-notes"><summary>{recording.warnings.length} recording {recording.warnings.length === 1 ? 'note' : 'notes'}</summary><ul>{recording.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}
    </section>}>
    <ReplaySession key={revision} state={player.state} status={player.status} />
  </DebugSessionView>;
}
