import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web/headless';
import { useSessionView, AgentComposer, AgentTimeline } from '@orchardworks/agent-remote-web/react';
import '../../src/session-view-styles';
const transport = new HttpWebSocketTransport(location.origin, { sessionChannels: false });
const agentId = new URLSearchParams(location.search).get('agent') ?? 'resource-desktop';
function Fixture() {
  const [fail, setFail] = useState(false);
  const session = useSessionView({ agentId, transport });
  return <main style={{ maxWidth: 900, margin: 'auto' }}>
    <button onClick={() => setFail(value => !value)}>Toggle upload rejection</button>
    <p data-testid="connection">{session.status}</p>
    {session.state ? <AgentTimeline state={session.state} onDownloadResource={session.actions.downloadResource} /> : null}
    <AgentComposer state={session.state} sessionState={session.sessionState} sessionKey={agentId} draftScope={`resource-browser:${agentId}`}
      onSendMessageContent={session.actions.sendMessageContent} onSendMessage={session.actions.sendMessage}
      onUploadResource={session.actions.uploadResource ? (file, name, id, options) => session.actions.uploadResource!(file, fail ? '' : name, id, options) : undefined} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
