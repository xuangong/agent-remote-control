import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
import { LabWorkbench } from '../../agent-remote-lab/src/components/LabWorkbench.js';
import { ToastProvider } from '../../agent-remote-lab/src/components/Toast.js';
import { useConversationSession } from '../../agent-remote-lab/src/hooks/useConversationSession.js';
import type { OpenedSession } from '../../agent-remote-lab/src/directory-client.js';
import { trackFocusModality } from '../../agent-remote-lab/src/focus-modality.js';
import { createBrowserTrace } from './browser-trace.js';
import '@orchardworks/agent-remote-web/styles.css';
import '../../agent-remote-lab/src/app.css';
import './shell.css';

function SessionView({ session }: { session: OpenedSession }) {
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
  return <ToastProvider><LabWorkbench state={state} sessionStatus={status} attachingAgentId={session.agentId}
    actions={actions} questionDrafts={questions} draftSessionKey={session.agentId}
    onQuestionDraftChange={(id, draft) => setQuestions(current => ({ ...current, [id]: draft }))} /></ToastProvider>;
}

trackFocusModality(document);
const root = createRoot(document.getElementById('root')!);
async function open() {
  try {
    const response = await fetch('/__ardb/session', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Session bootstrap failed (${response.status}).`);
    root.render(<SessionView session={await response.json() as OpenedSession} />);
  } catch (error) {
    root.render(<main role="alert"><p>{error instanceof Error ? error.message : 'Unable to open session.'}</p><button onClick={() => void open()}>Retry</button></main>);
  }
}
void open();
