import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentChildSessionList } from '@orchardworks/agent-remote-web/react';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { SessionDirectory } from '../../src/components/SessionDirectory.js';
import { ChatSessionManager } from '../../src/components/ChatSessionManager.js';
import { CollapsedConversations } from '../../src/components/CollapsedConversations.js';
import { SessionDirectoryClient } from '../../src/directory-client.js';
import { useSessionEntries } from '../../src/hooks/useSessionEntries.js';
import { replicaState } from '../../src/test/fixtures.js';
import '@orchardworks/agent-remote-web/styles.css';
import '../../src/app.css';

const opened = [{ agentId: 'agent-1', nativeSessionId: 'recorded-session', providerId: 'recorded', title: 'Current session' }];
const directory = new SessionDirectoryClient(location.origin);
directory.cachedPages.set('recorded', { revision: '1', hasMore: false, items: [{
  nativeSessionId: 'recorded-session', providerId: 'recorded', title: 'Current session', state: 'idle', createdAt: '2026-09-18', updatedAt: '2026-09-18',
}] });
const running = { ...replicaState.agent!, status: 'running' as const, activeTurn: { turnId: 'turn', startedAt: '2026-09-18T00:00:00Z' } };
const childSessions = ['running', 'waiting', 'idle', 'closed'].map(status => ({
  nativeSessionId: status, title: `${status} child`, status: status as 'running' | 'waiting' | 'idle' | 'closed',
}));

function Fixture() {
  const [mode, setMode] = useState('idle');
  const state = useMemo(() => ({ ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false },
    agent: mode === 'running' || mode === 'pending' ? running : { ...replicaState.agent!, status: mode === 'closed' ? 'closed' as const : 'idle' as const },
    pendingInteractions: mode === 'pending' ? [{ kind: 'plan_approval' as const, requestId: 'review', plan: 'Review the plan', allowedActions: ['approve' as const] }] : [],
  }), [mode]);
  const entries = useSessionEntries(opened, state);
  return <main className="lab-shell" style={{ display: 'block', padding: 16 }}>
    <nav aria-label="Fixture state">{['idle', 'running', 'pending', 'closed'].map(mode => <button key={mode} onClick={() => setMode(mode)}>{mode}</button>)}</nav>
    <div style={{ height: 280 }}><LabWorkbench state={state} sessionStatus="ready" actions={{}} /></div>
    <ChatSessionManager current={entries[0]!} entries={entries} busy={false} onOpen={() => {}} />
    <CollapsedConversations sessions={opened} entries={entries} offset={0} onExpand={() => {}} />
    <SessionDirectory directory={directory} providerId="recorded" activeAgentId="agent-1" opened={opened} known={entries}
      busy={false} revision={0} onOpen={() => {}} onSelect={() => {}} onClose={() => {}} />
    <AgentChildSessionList children={childSessions} onOpenChildSession={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
