import { LiveControls, useLiveRecording } from './live-controls.js';
import { RecordingPicker, type OpenedRecording } from './recording-picker.js';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
import { SessionWorkbench } from '../../agent-remote-lab/src/components/SessionWorkbench.js';
import { DebugControlsState, DebugSessionView } from './session-view.js';
import { useSessionView } from '@orchardworks/agent-remote-web/react';
import type { OpenedSession } from '../../agent-remote-lab/src/directory-client.js';
import { trackFocusModality } from '../../agent-remote-lab/src/focus-modality.js';
import { ReplayView } from './replay.js';
import { RecordingPlayer, type SessionRecording } from '../src/recording.js';
import { createBrowserTrace } from './browser-trace.js';
import { ModeControls } from './mode-controls.js';
import '../../agent-remote-lab/src/session-view-styles.js';
import './shell.css';

type ViewProps = { mode: 'live' | 'replay'; recording?: OpenedRecording; player?: RecordingPlayer; modeControls: ReactNode; onOpen(recording: OpenedRecording): void };
function Playback({ modeControls, recording, player, onOpen, liveControls, recordingActive }: ViewProps & { liveControls?: ReactNode; recordingActive?: boolean }) {
  if (recording && player) return <ReplayView {...recording} player={player} onOpen={onOpen} modeControls={modeControls} liveControls={liveControls} recordingActive={recordingActive} />;
  return <DebugSessionView modeControls={modeControls} liveControls={liveControls} recordingActive={recordingActive} playbackControls={<section className="ardb-playback"><RecordingPicker onOpen={onOpen} /></section>}>
    <div className="ardb-empty-view">Open a server recording from the controls to replay it.</div>
  </DebugSessionView>;
}
function SessionView({ session, ...view }: ViewProps & { session: OpenedSession }) {
  const capture = useLiveRecording();
  const trace = useMemo(() => createBrowserTrace(), []);
  const transport = useMemo(() => {
    const value = new HttpWebSocketTransport(location.origin);
    value.onProtocolMessage(trace.protocol);
    value.onDiagnostic(diagnostic => trace.record({ event: 'diagnostic', code: diagnostic.code }));
    return value;
  }, [trace]);
  const { state, handoff, status, questions, setQuestions, actions } = useSessionView({ agentId: session.agentId, transport });
  useEffect(() => { trace.record({ event: 'connection', status }); }, [status, trace]);
  useEffect(() => () => trace.close(), [trace]);
  const controls = <LiveControls capture={capture} agentId={session.agentId} onOpen={view.mode === 'live' ? view.onOpen : undefined} />;
  const recordingActive = capture.status?.phase === 'recording';
  if (view.mode === 'replay') return <Playback {...view} liveControls={controls} recordingActive={recordingActive} />;
  return <DebugSessionView modeControls={view.modeControls} liveControls={controls} recordingActive={recordingActive}><SessionWorkbench handoff={handoff} state={state} sessionStatus={status} attachingAgentId={session.agentId}
    actions={actions} questionDrafts={questions} draftSessionKey={session.agentId}
    onQuestionDraftChange={(id, draft) => setQuestions(current => ({ ...current, [id]: draft }))} /></DebugSessionView>;
}
function Workspace({ initialSession, initialRecording, directory = '', executable }: {
  initialSession?: OpenedSession; initialRecording?: OpenedRecording; directory?: string; executable?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [session, setSession] = useState(initialSession);
  const [recording, setRecording] = useState(initialRecording);
  const [mode, setMode] = useState<'live' | 'replay'>(initialRecording ? 'replay' : 'live');
  const player = useMemo(() => recording ? new RecordingPlayer(recording.recording) : undefined, [recording]);
  const selectMode = (next: 'live' | 'replay') => { player?.pause(); setMode(next); };
  const onOpen = (next: OpenedRecording) => { setRecording(next); setMode('replay'); };
  const modeControls = <ModeControls mode={mode} onMode={selectMode} onClear={() => { player?.pause(); setRecording(undefined); setMode('replay'); }} session={session} directory={directory} executable={executable}
    onStarted={value => { setSession(value); setMode('live'); }} />;
  const view: ViewProps = { mode, recording, player, modeControls, onOpen };
  const content = session ? <SessionView {...view} session={session} />
    : mode === 'replay' ? <Playback {...view} />
    : <DebugSessionView modeControls={modeControls}><div className="ardb-empty-view">Choose Live or Replay in the top-right controls.</div></DebugSessionView>;
  return <DebugControlsState.Provider value={{ expanded, setExpanded }}>{content}</DebugControlsState.Provider>;
}

trackFocusModality(document);
const root = createRoot(document.getElementById('root')!);
async function open() {
  try {
    const response = await fetch('/__ardb/session', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Session bootstrap failed (${response.status}).`);
    const bootstrap = await response.json() as OpenedSession | { mode: 'replay' | 'workspace'; name?: string; directory: string; executable?: string; live?: OpenedSession };
    if ('mode' in bootstrap) {
      let recording: OpenedRecording | undefined;
      if (bootstrap.mode === 'replay') {
        const data = await fetch('/__ardb/initial-recording', { signal: AbortSignal.timeout(30000) });
        if (!data.ok) throw new Error(`Recording load failed (${data.status}).`);
        recording = { name: bootstrap.name!, recording: await data.json() as SessionRecording };
      }
      root.render(<Workspace initialSession={bootstrap.live} initialRecording={recording} directory={bootstrap.directory} executable={bootstrap.executable} />);
    } else root.render(<Workspace initialSession={bootstrap} />);
  } catch (error) {
    root.render(<main role="alert"><p>{error instanceof Error ? error.message : 'Unable to open session.'}</p><button onClick={() => void open()}>Retry</button></main>);
  }
}
void open();
