import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TpmWork, AgentSnapshot, HistoryPage } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDockProvider, SessionDockRail } from '../../src/components/SessionDock';
import { ConversationPane, ConversationSplit } from '../../src/components/ConversationSplit';
import { SessionWorkbench } from '../../src/components/SessionWorkbench';
import { AskConversation } from '../../src/components/AskConversation';
import { TpmMenu } from '../../src/components/TpmMenu';
import { TpmWorkspace } from '../../src/components/TpmWorkspace';
import { useTpmWork, type TpmService } from '../../src/hooks/useTpmWork';
import { DraftStore } from '../../src/draft-store';
import { replicaState } from '../../src/test/fixtures';
import { tpmMainTarget } from '../../src/tpm-main-sessions';
import { sessionKey } from '../../src/session-tree';
import '../../src/session-view-styles';
import '../../src/ask.css';
import '../../src/tpm.css';

const main = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', title: 'Agent Remote Control' };
const other = { ...main, nativeSessionId: 'other', title: 'Website reliability' };
const labels = new Map([main, other].map(item => [sessionKey(item), { ...item, workspace: '/Projects/' + item.nativeSessionId }]));
const initialWorks: TpmWork[] = [
  ['one', 'Search delivery', 'main', false], ['two', 'Connection recovery', 'main', false], ['three', 'Image viewer', 'other', false], ['archived', 'Old delivery', 'main', true],
].map(([id, title, mainNativeSessionId, archived], index) => ({ id: String(id), title: String(title), mainNativeSessionId: String(mainNativeSessionId), archived: !!archived,
  tpmNativeSessionId: `native-${id}`, providerId: 'codex', revision: 1, phase: 'clarifying', waiting: 'none', paused: false, delegated: false,
  summary: 'Discuss the requirements and delivery plan.', nextAction: '', document: '# Delivery plan\n\nClarify scope, implement, and verify.', acceptance: '', evidence: [],
  createdAt: '2026-10-12', updatedAt: `2026-10-12T00:00:0${9 - index}Z`, nextCheckAt: 0 }));
const drafts = new DraftStore('tpm-dock-fixture');
const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.7.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, id } });
const timeline = (id: string): HistoryPage => ({ protocolVersion: '1.7.0', type: 'timeline_page', payload: {
  agentId: id, requestId: 'history', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 20, nextSeq: 21 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 20 },
  entries: Array.from({ length: 20 }, (_, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-12T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { ...(index < 4 ? { background: { id: 'fixture-review', kind: 'review' as const, status: 'silent' as const } } : {}), type: 'assistant_message' as const, text: `Review ${index + 1}: We can keep this session focused on one delivery while checking the main session for progress.\n\nThe acceptance criteria and next steps stay visible in this conversation.` } })),
  hasOlder: false, hasNewer: false, error: null } });
let connections = 0;
const transport: RemoteAgentTransport = {
  fetchSnapshot: async id => snapshot(id), fetchTimeline: async id => timeline(id), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: (id, listener) => {
    document.documentElement.dataset.fixtureConnections = String(++connections);
    queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
    return { close: () => {}, send: message => {
      if (message.type === 'negotiate') {
        listener.onMessage({ protocolVersion: '1.7.0', type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.7.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.7.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
    } };
  },
};
function Fixture() {
  const [compact, setCompact] = useState(window.innerWidth <= 1180);
  useEffect(() => { const resize = () => setCompact(window.innerWidth <= 1180); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const records = useRef(initialWorks);
  const service = useMemo<TpmService>(() => ({ tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: records.current }),
    tpmWork: async (_host, id) => records.current.find(work => work.id === id)!, tpmCreate: async () => records.current[0]!,
    tpmAction: async (_host, id, input) => {
      records.current = records.current.map(work => work.id === id ? { ...work, revision: work.revision + 1, ...(input.action === 'set_delegated' ? { delegated: input.delegated } : { archived: input.action === 'archive', paused: input.action === 'archive' }) } : work);
      return records.current.find(work => work.id === id)!;
    } }), []);
  const tpm = useTpmWork(service, [{ id: 'host', name: 'Mac mini', online: true }], true, async target => ({ ...target, agentId: target.nativeSessionId }), true, 'tpm-dock-fixture');
  const trigger = useRef<HTMLButtonElement>(null), askTrigger = useRef<HTMLButtonElement>(null);
  const [listOpen, setListOpen] = useState(false), [askOpen, setAskOpen] = useState(false);
  return <SessionDockProvider enabled={!compact} storageScope="tpm-dock-fixture"><main className="lab-shell" style={{ display: 'flex', padding: 12, flexDirection: 'column', gap: 8 }}>
    <nav style={{ display: 'flex', gap: 8 }}><strong>TPM and Dock</strong><button ref={askTrigger} onClick={() => setAskOpen(true)}>Open Ask</button></nav>
    <TpmMenu tpm={tpm} main={main} mainSessions={labels} visible triggerRef={trigger} inert={false} open={listOpen} onOpenChange={setListOpen} />
    <div className="lab-tpm-workspaces">{tpm.opened.map((key, index) => {
      const item = tpm.works.find(item => item.key === key);
      if (!item) return null;
      return <TpmWorkspace key={key} item={item} mainTitle={labels.get(sessionKey(tpmMainTarget(item)))?.title} session={tpm.sessions[key]} transport={transport} storageScope="fixture" triggerRef={trigger}
        visible={tpm.windows.includes(key) && (!compact || tpm.selected === key)} layer={tpm.windows.indexOf(key) + 1} initialOffset={index * 28}
        onFocus={() => tpm.focus(key)} draftBinding={{ store: drafts, key }} onClose={() => tpm.close(key)} onShowList={() => setListOpen(true)}
        onOpenMain={() => {}} onAction={action => tpm.action(key, action)} onResolve={async () => {}} onRetry={() => { void tpm.open(key); }} />;
    })}</div>
    <SessionDockRail minimumBaseWidth={compact ? 320 : 640}><ConversationSplit compact={compact} start={0} end={compact ? 0 : 1}>
      <ConversationPane className="lab-primary-conversation lab-session-composition"><SessionWorkbench state={replicaState} sessionStatus="ready" conversationPath={<strong>Main agent</strong>} actions={{ sendMessage: async () => {} }} />
        {askOpen ? <AskConversation entry={{ source: { ...main, agentId: 'main' } }} storageScope="fixture-ask" triggerRef={askTrigger} transport={transport} draftBinding={{ store: drafts, key: 'ask' }}
          onClose={() => setAskOpen(false)} onToggleEnabled={() => {}} onClean={() => {}} onRetry={() => {}} onSendInput={() => {}} onDiscardInput={() => {}} /> : null}
      </ConversationPane>
      <ConversationPane position={1} hidden={compact} className="lab-side-conversation lab-session-composition"><SessionWorkbench state={replicaState} sessionStatus="ready" conversationPath={<strong>Subagent</strong>} actions={{ sendMessage: async () => {} }} /></ConversationPane>
    </ConversationSplit></SessionDockRail>
  </main></SessionDockProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
