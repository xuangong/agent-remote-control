// The Ask window of a session on builder states: a primary conversation and the global Ask surface (`.lab-ask-workspaces`) with the real
// `SessionAsk` and `AskButton`, a mock transport and no Relay. Query: `open` (the Ask is open), `imageInput`, `running` (the Ask's turn
// runs), `floating` (the launcher floats instead of sitting in a bar), `resources` (the Ask's answer links a file). `setAskObservation`
// gives the launcher the activity Track observes.
import { createRef, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewProvider, PreviewWorkspace } from '@orchardworks/agent-client-web/react';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-client';
import type { AgentSnapshot, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { SessionAsk } from '../../src/components/SessionAsk';
import { AskButton } from '../../src/components/AskButton';
import { SessionWorkbench } from '../../src/conversation/ConversationSurface';
import { ShortcutPlacement } from '../../src/shell/shortcut-placement';
import { useVisualViewport } from '../../src/hooks/useVisualViewport';
import { DraftStore } from '../../src/draft-store';
import { ForkStore, referenceForkContext } from '../../src/session-forks';
import { askParticipantKey, type AskEntry } from '../../src/hooks/useAskConversations';
import { sessionKey } from '../../src/session-tree';
import type { SessionObservation } from '../../src/tracking-state';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';
import '../../src/ask.css';

const query = new URLSearchParams(window.location.search);
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const target = { ...source, nativeSessionId: 'ask-target', agentId: 'ask-agent', title: 'Ask' };
const scope = 'ask-window-fixture';
const drafts = new DraftStore(scope);
const forks = new ForkStore(scope, sessionStorage);
const record = forks.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
forks.bind(record.id, target);
const bound = forks.get(record.id)!;
const entry: AskEntry = { source, attached: true, record: bound, attachedParticipant: askParticipantKey(bound) };

type SessionSetting = NonNullable<NonNullable<AgentSnapshot['payload']['runtimeInfo']>['settings']>[number];
const settings: SessionSetting[] = [
  { id: 'model', category: 'model', label: 'Model', value: 'gpt-6-astra', options: [{ value: 'gpt-6-astra', label: 'GPT-6-Astra' }], mutable: true, scope: 'session' },
  { id: 'approval', category: 'permissions', label: 'Approval policy', value: 'never', options: [{ value: 'never', label: 'Never ask' }], mutable: true, scope: 'session' },
];
const snapshot = (id: string): AgentSnapshot => {
  const agent = replicaState.agent!;
  const running = query.has('running') && id === target.agentId;
  return { protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...agent, id, providerId: source.providerId, status: running ? 'running' : 'idle',
    activeTurn: running ? { turnId: 'ask-turn', startedAt: new Date().toISOString() } : null,
    capabilities: { ...agent.capabilities, steer: true, cancel: true, commands: true, planning: true, sessionSettings: true,
      ...(query.has('imageInput') ? { imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) },
    runtimeInfo: { ...agent.runtimeInfo, providerId: source.providerId, sessionId: id === target.agentId ? target.nativeSessionId : source.nativeSessionId, model: 'gpt-6-astra', status: running ? 'running' : 'idle', planning: { active: false }, settings: [...settings] } } };
};
const answer = query.has('resources') ? 'The proof is in [lab-proof.txt](artifacts/lab-proof.txt).' : 'The choice keeps the reading order simple.';
const timeline = (id: string): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
  agentId: id, requestId: 'history', direction: 'tail', epoch: 'epoch', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 6, nextSeq: 7 }, startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 6 },
  entries: Array.from({ length: 6 }, (_, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-10-12T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
    item: { type: 'assistant_message' as const, messageId: `m${index}`, text: index === 5 ? answer : `Answer ${index + 1}: a readable line of the conversation.` } })),
  hasOlder: false, hasNewer: false, error: null } });
const transport: RemoteAgentTransport = {
  fetchSnapshot: async id => snapshot(id), fetchTimeline: async id => timeline(id), onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: (id, listener) => {
    queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
    return { close: () => {}, send: message => {
      if (message.type === 'negotiate') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
    } };
  },
};

const triggerRef = createRef<HTMLButtonElement>();
const replica = new AgentReplica();
const primaryState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false }, agent: { ...replicaState.agent!, id: source.agentId,
  capabilities: { ...replicaState.agent!.capabilities, commands: true, sessionSettings: true },
  runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [...settings] } } };

function Fixture() {
  const [open, setOpen] = useState(query.has('open'));
  const [panel, setPanel] = useState(false);
  const [primaryDraft, setPrimaryDraft] = useState('');
  const [observation, setObservation] = useState<SessionObservation>();
  useEffect(() => { (window as unknown as { setAskObservation(value: SessionObservation): void }).setAskObservation = setObservation; }, []);
  const ask = useMemo(() => ({
    sharedView: () => undefined, entryFor: () => entry, isEnabled: () => true, isOpen: () => open, restore: () => undefined, drafts, store: forks,
    associationOwner: (id: string) => ({ id, sourceSlot: id, geometryScope: id, text: { scope, key: id }, input: { scope, key: id }, open: true }),
    draftBinding: () => ({ store: drafts, key: 'ask' }), close: () => setOpen(false), minimize: () => setOpen(false), toggle: () => {}, sendInput: () => {}, discardInput: () => {},
  }) as unknown as Parameters<typeof SessionAsk>[0]['ask'], [open]);
  const shell = useVisualViewport();
  const floating = query.has('floating');
  const launcher = <ShortcutPlacement.Provider value={floating ? 'floating' : 'bar'}>
    <AskButton triggerRef={triggerRef} disabled={false} sourceTitle={source.title} observation={observation} onOpen={() => setOpen(true)} />
  </ShortcutPlacement.Provider>;
  // The page reserves a second row for the navigation on a compact screen, and the Ask surface floats over the row below it.
  return <main ref={shell} className="lab-shell lab-context-hidden" style={{ gridTemplateRows: '48px minmax(0, 1fr)' }}>
    <style>{'@media (max-width: 1180px) { .lab-shell { grid-template-rows: 48px 44px minmax(0, 1fr) !important; } .lab-main-stage { grid-row: 3 !important; } }'}</style>
    <header className="lab-app-bar" style={{ gridColumn: '1 / -1' }}><strong>Ask window fixture</strong>{floating ? null : launcher}
      <button type="button" onClick={() => setPanel(true)}>Windows</button></header>
    <PreviewWorkspace className="lab-main-stage" style={{ gridColumn: '1 / -1', gridRow: 2, minHeight: 0 }}>
      <div className="lab-primary-conversation" style={{ height: '100%' }}>
        <SessionWorkbench state={primaryState} sessionStatus="ready" conversationPath={<strong>Main</strong>} actions={{ sendMessage: async () => {} }} messageDraft={primaryDraft} onMessageDraftChange={setPrimaryDraft} />
      </div>
    </PreviewWorkspace>
    {panel ? <section aria-label="Windows" style={{ position: 'fixed', top: 60, right: 12, zIndex: 150, background: 'white', padding: 8 }}><button type="button" onClick={() => setPanel(false)}>Close Windows</button></section> : null}
    <div className="lab-ask-workspaces">
      {floating ? launcher : null}
      <SessionAsk source={source} ask={ask} visible canRestore={false} storageScope={scope} associationOwner={sessionKey(source)} synchronize={async () => {}}
        onOpen={() => {}} onToggleEnabled={() => {}} triggerRef={triggerRef} replicaFor={() => replica} transport={transport}
        navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<PreviewProvider client={{} as never} hostId="local" enabled={false} canManage={false} polling={false}><Fixture /></PreviewProvider>);
