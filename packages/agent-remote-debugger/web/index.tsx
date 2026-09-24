import { LiveControls, useLiveRecording } from './live-controls.js';
import type { OpenedRecording } from './recording-picker.js';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
import { LabWorkbench } from '../../agent-remote-lab/src/components/LabWorkbench.js';
import { DebugSessionView } from './session-view.js';
import { useConversationSession } from '../../agent-remote-lab/src/hooks/useConversationSession.js';
import type { OpenedSession } from '../../agent-remote-lab/src/directory-client.js';
import { trackFocusModality } from '../../agent-remote-lab/src/focus-modality.js';
import { ReplayView } from './replay.js';
import type { SessionRecording } from '../src/recording.js';
import { createBrowserTrace } from './browser-trace.js';
import '../../agent-remote-lab/src/session-view-styles.js';
import './shell.css';

function SessionView({ session }: { session: OpenedSession }) {
  const capture = useLiveRecording();
  const [replay, setReplay] = useState<OpenedRecording>();
  const trace = useMemo(() => createBrowserTrace(), []);
  const transport = useMemo(() => {
    const value = new HttpWebSocketTransport(location.origin);
    value.onProtocolMessage(trace.protocol);
    value.onDiagnostic(diagnostic => trace.record({ event: 'diagnostic', code: diagnostic.code }));
    return value;
  }, [trace]);
  const { state, status, questions, setQuestions, actions } = useConversationSession(session, transport);
  useEffect(() => { trace.record({ event: 'connection', status }); }, [status, trace]);
  useEffect(() => () => trace.close(), [trace]);
  const controls = <LiveControls capture={capture} agentId={session.agentId} onOpen={replay ? undefined : setReplay} />;
  const recordingActive = capture.status?.phase === 'recording';
  if (replay) return <ReplayView {...replay} liveControls={controls} recordingActive={recordingActive} onReturnLive={() => setReplay(undefined)} />;
  return <DebugSessionView liveControls={controls} recordingActive={recordingActive}><LabWorkbench state={state} sessionStatus={status} attachingAgentId={session.agentId}
    actions={actions} questionDrafts={questions} draftSessionKey={session.agentId}
    onQuestionDraftChange={(id, draft) => setQuestions(current => ({ ...current, [id]: draft }))} /></DebugSessionView>;
}

trackFocusModality(document);
const root = createRoot(document.getElementById('root')!);
async function open() {
  try {
    const response = await fetch('/__ardb/session', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Session bootstrap failed (${response.status}).`);
    const bootstrap = await response.json() as OpenedSession | { mode: 'replay'; name: string };
    if ('mode' in bootstrap && bootstrap.mode === 'replay') {
      const data = await fetch('/__ardb/recording', { signal: AbortSignal.timeout(30000) });
      if (!data.ok) throw new Error(`Recording load failed (${data.status}).`);
      root.render(<ReplayView name={bootstrap.name} recording={await data.json() as SessionRecording} />);
    } else root.render(<SessionView session={bootstrap as OpenedSession} />);
  } catch (error) {
    root.render(<main role="alert"><p>{error instanceof Error ? error.message : 'Unable to open session.'}</p><button onClick={() => void open()}>Retry</button></main>);
  }
}
void open();
