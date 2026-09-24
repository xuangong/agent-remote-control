import { RecordingPicker } from './recording-picker.js';
import { memo, useEffect, useState } from 'react';
import type { AgentReplicaState, RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { LabWorkbench, type LabWorkbenchActions } from '../../agent-remote-lab/src/components/LabWorkbench.js';
import { DebugSessionView } from './session-view.js';
import { RecordingPlayer, type SessionRecording } from '../src/recording.js';

const noActions: LabWorkbenchActions = {};
const ReplaySession = memo(function ReplaySession({ state, status }: { state: AgentReplicaState; status: RemoteSessionStatus }) {
  return <LabWorkbench readOnly state={state} sessionStatus={status} actions={noActions} draftSessionKey={`replay:${state.agent?.id}`} />;
});
const time = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}:${(milliseconds / 1000 % 60).toFixed(1).padStart(4, '0')}`;

export function ReplayView({ name, recording, player, onOpen, modeControls, liveControls, recordingActive = false }: {
  name: string; recording: SessionRecording; player: RecordingPlayer;
  onOpen(recording: import('./recording-picker.js').OpenedRecording): void;
  modeControls?: import('react').ReactNode; liveControls?: import('react').ReactNode; recordingActive?: boolean;
}) {
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
  return <DebugSessionView modeControls={modeControls} liveControls={liveControls} recordingActive={recordingActive} playbackControls={
    <section className="ardb-playback" aria-label="Recording playback">
      <div className="ardb-recording-heading"><div className="ardb-recording-title"><strong title={name}>{name}</strong><span>Session recording · Read only</span></div>
        <RecordingPicker onOpen={onOpen} />
      </div>
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
    <ReplaySession key={recording.agentId} state={player.state} status={player.status} />
  </DebugSessionView>;
}
