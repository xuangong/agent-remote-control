// The assistant's conversation on builder states (I3 plan, Task A8): a turn of every item kind, a running turn, every pending
// interaction, outgoing messages, older history and an earlier session in the chain, inside the Lab's workbench.
// ?layout=bot shows it in Bot mode's three panels with two more assistants (I3 plan, Task B2).
// ?mode=concise|process|full sets this device's process mode; ?theme=light|dark|system the appearance; ?width=phone narrows the
// page; ?status=connecting makes requests wait for the connection; ?respond=none leaves them unanswerable; ?pending=none answers
// every request, so the last turn runs with its live line; ?older=1 leaves older pages of this session to load. The words follow
// the browser's language.
import { useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { PROTOCOL_VERSION, type AgentInteractionRequest } from '@orchardworks/agent-remote-protocol';
import { createReplicaState, translator, type AgentReplicaState, type RemoteSessionStatus } from '@orchardworks/agent-client';
import { buildEveryKindConversation, buildTailPage, TimelineRows } from '@orchardworks/agent-client/testing';
import { bindAppearance } from '@orchardworks/agent-client-web/browser';
import { browserLocale, LocaleProvider } from '@orchardworks/agent-client-web/react';
import { deviceChoices } from '../../src/kernel/device-choices.js';
import { AssistantAvatar, MotionProvider } from '@orchardworks/agent-client-web/primitives';
import { LabWorkbench } from '../../src/conversation/LabWorkbench.js';
import { EarlierConversation, type EarlierTransport } from '../../src/conversation/EarlierConversation.js';
import { ReplicaInspector } from '../../src/features/diagnostics/ReplicaInspector.js';
import { ToastProvider } from '../../src/kernel/Toast.js';
import '../../src/session-view-styles';
import { BotFixture, SAMPLE } from './assistant-layouts.js';

const params = new URLSearchParams(location.search);
const appearance = bindAppearance(document, localStorage);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark' || theme === 'system') appearance.set(theme);
const mode = params.get('mode');
if (mode === 'concise' || mode === 'process' || mode === 'full') localStorage.setItem('agent-remote:process-mode', mode);
else localStorage.removeItem('agent-remote:process-mode');
if (params.get('width') === 'phone') document.documentElement.style.maxWidth = '390px';
const status: RemoteSessionStatus = params.get('status') === 'connecting' ? 'connecting' : 'ready';
const locale = browserLocale();
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';

const conversation = buildEveryKindConversation({ locale });
const zh = locale === 'zh';
const invalid: AgentInteractionRequest = { kind: 'tool_approval', requestId: 'pending-invalid', toolCallId: 'call-invalid', toolName: 'Bash', summary: 'Allow Bash?',
  detail: { type: 'shell', command: 'rm -rf build' }, allowedDecisions: ['allow'], allowScopes: [] };
const base = createReplicaState();
const answered = params.get('pending') === 'none';
const state: AgentReplicaState = { ...base, agent: { ...conversation.snapshot, status: answered ? 'running' : 'waiting' },
  pendingInteractions: answered ? [] : [...conversation.pendingInteractions, invalid],
  timeline: { ...base.timeline, epoch: 'fixture', initialized: true, entries: conversation.entries, nextSeq: conversation.entries.length + 1, hasOlder: params.get('older') === '1' },
  outgoingMessages: [
    { id: 'outgoing-sending', agentId: conversation.snapshot.id, text: zh ? '顺便把标题改成「IM 原则」。' : 'Also rename the title to IM principles.', status: 'sending' },
    { id: 'outgoing-failed', agentId: conversation.snapshot.id, text: zh ? '再加一行总结。' : 'And add a summary line.', status: 'failed', error: zh ? '电脑没有接收这条消息。' : 'The Host did not accept the message.' },
  ] };

/** The session before this one, in the assistant's chain: read once, then the one before it fails after a moment of loading. */
const earlierRows = new TimelineRows('claude', Date.parse('2026-11-19T09:00:00Z'));
earlierRows.user(zh ? '开始写笔记。' : 'Start the notes.', { key: 'earlier-prompt', turnId: 'earlier-1' });
earlierRows.assistant(zh ? '已经建好 notes.md，加了标题。' : 'Started notes.md with a title.', { key: 'earlier-answer', turnId: 'earlier-1' });
const earlierTransport: EarlierTransport = {
  fetchSnapshot: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...conversation.snapshot, id: agentId, status: 'idle', activeTurn: null } }),
  fetchTimeline: async agentId => buildTailPage(earlierRows.entries, { epoch: `epoch-${agentId}`, agentId }),
};
const earlierDirectory = () => ({ attach: async (_providerId: string, nativeSessionId: string) => {
  if (nativeSessionId === 'oldest') { await new Promise(resolve => setTimeout(resolve, 600)); throw new Error('Unavailable'); }
  return { agentId: `agent-${nativeSessionId}` };
} });

function Conversation() {
  const [selected, setSelected] = useState<ReadonlySet<string>>();
  const [inspected, setInspected] = useState<string>();
  const respond = params.get('respond') === 'none' ? undefined : () => new Promise<void>(() => {});
  return <ToastProvider><div className="lab-shell fixture-assistant" style={{ display: 'block', height: '100dvh' }}>
    <EveryKindWorkbench selected={selected} setSelected={setSelected} respond={respond} setInspected={setInspected} />
    <details className="fixture-inspector"><summary>Replica Inspector</summary>
      <p data-testid="inspected">{inspected ?? ''}</p>
      <ReplicaInspector state={state} sessionStatus={status} providerName="Claude Code" />
    </details>
  </div></ToastProvider>;
}

/** Chief's conversation: every kind of entry, as the Lab's workbench shows it. */
export function EveryKindWorkbench({ selected, setSelected, respond, setInspected, ...props }: { selected?: ReadonlySet<string>; setSelected(keys: ReadonlySet<string>): void;
  respond?: () => Promise<void>; setInspected(key: string): void } & Partial<ComponentProps<typeof LabWorkbench>>) {
  return <LabWorkbench state={state} sessionStatus={status} draftSessionKey="every-kind"
      assistant={{ name: SAMPLE.names[0]!, avatar: <AssistantAvatar id="chief" picture={{ shape: 'triangle', color: '#ff8a3d', gaze: 1 }} size={26} mood="working" /> }}
      onInspectEntry={key => setInspected(key)}
      entrySelection={{ selected, label: translator(locale)('sessions.quotes.quote'), select(keys, value) { const next = new Set(selected); for (const key of keys) if (value) next.add(key); else next.delete(key); setSelected(next); } }}
      timelineStart={<EarlierConversation baseUrl="http://fixture/" transport={earlierTransport} directory={earlierDirectory}
        sessions={[{ hostId: 'local', providerId: 'claude', nativeSessionId: 'earlier', title: SAMPLE.earlier }, { hostId: 'local', providerId: 'claude', nativeSessionId: 'oldest', title: SAMPLE.oldest }]}
        readCached={() => undefined} />}
      actions={{
        ...(respond ? { respondToInteraction: respond } : {}),
        sendMessage: async () => {}, retryMessage: async () => {}, deleteMessage: () => {}, editPrompt: async () => {}, cancel: async () => {},
        loadOlder: async () => { await new Promise(resolve => setTimeout(resolve, 300)); throw new Error('Earlier activity could not be loaded.'); },
      }} {...props} />;
}

function Fixture() {
  const [selected, setSelected] = useState<ReadonlySet<string>>();
  const respond = params.get('respond') === 'none' ? undefined : () => new Promise<void>(() => {});
  if (params.get('layout') === 'bot') return <ToastProvider><BotFixture conversation={extra => <EveryKindWorkbench selected={selected} setSelected={setSelected} respond={respond} setInspected={() => {}} {...extra} />} /></ToastProvider>;
  return <Conversation />;
}

createRoot(document.getElementById('root')!).render(<LocaleProvider language={deviceChoices().language}><MotionProvider><Fixture /></MotionProvider></LocaleProvider>);
