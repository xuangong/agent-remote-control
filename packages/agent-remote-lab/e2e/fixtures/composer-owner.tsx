import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentComposer } from '@orchardworks/agent-client-web/react';
import { remoteSessionState } from '@orchardworks/agent-client';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

// One composer with one draft owner. The session behind it moves from A to B on a custom event, as a native confirmation does.
const stateOf = (sessionId: string) => ({ ...replicaState, agent: { ...replicaState.agent!, id: sessionId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId } } });
function Fixture() {
  const [sessionId, setSessionId] = useState('A'), [draft, setDraft] = useState('Keep this focused selection');
  useEffect(() => {
    const move = (event: Event) => setSessionId((event as CustomEvent<string>).detail);
    window.addEventListener('fixture:move-session', move);
    return () => window.removeEventListener('fixture:move-session', move);
  }, []);
  const state = stateOf(sessionId);
  document.documentElement.dataset.session = sessionId;
  return <AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} draft={draft} imageDraftBinding={{ scope: 'fixture', key: 'view:primary' }}
    onDraftChange={setDraft} onSendMessage={async () => {}} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
