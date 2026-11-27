import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentComposer } from '@orchardworks/agent-client-web/react';
import { remoteSessionState } from '@orchardworks/agent-client';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

// One composer whose owner hands the draft back late (a store that publishes after a render of its own), while the page keeps
// rendering: a render that finds the owner's old value must not write it into the field. `?rich` gives the editor of image drafts.
const rich = new URLSearchParams(location.search).has('rich');
function Fixture() {
  const [draft, setDraft] = useState(''), [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 5); return () => clearInterval(timer); }, []);
  return <AgentComposer sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} draft={draft}
    {...(rich ? { imageDraftBinding: { scope: 'fixture', key: 'view:primary' } } : {})}
    onDraftChange={value => { setTimeout(() => setDraft(value), 30); }} onSendMessage={async () => {}} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
