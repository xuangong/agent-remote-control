// The team page of a chief as one card in its conversation, updated in place from the record (`window.rewrite()` plays the tracker bot's
// next write), and the bot's details with its Pages and the Primary control (`window.primaryMarks` records the person's choices).
// `?view=details` shows the details (`&surface=sheet` as the phone's sheet); the default shows the conversation.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createReplicaState } from '@orchardworks/agent-client';
import { AgentTimeline, LocaleProvider, ProcessModeContext, TaskDirectoryContext, type PageView, type TaskDirectory } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { AssistantDetails } from '../../src/conversation/assistant/AssistantDetails.js';
import '../../src/session-view-styles';
import './orchard-primitives.css';

const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const table = (rows: string[]) => ['| Task | Owner | Status |', '|---|---|---|', ...rows].join('\n');
const first = ['| Cut the release branch | Chief | done |', '| Run the regression on Windows, macOS and Linux with the long suite | Windows Worker 1 | working |'];
const base = Date.now() - 120_000;
const page = (contents: string, version: number, updatedAt: number, bot = 'Release tracker'): PageView => ({ pageId: 'pg_0a1b2c3d4e5f', botId: ids.tracker, bot, title: 'Release 2.0 tracker', contents, version, updatedAt, team: true });
let current = page(table(first), 1, base);
const notes: PageView = { pageId: 'pg_111111111111', botId: ids.chief, bot: 'Chief of staff', title: 'Meeting notes', contents: 'Agreed to ship on Friday.', version: 1, updatedAt: base - 3_600_000 };
const marks: boolean[] = (window as unknown as { primaryMarks: boolean[] }).primaryMarks = [];
const listeners = new Set<() => void>();
(window as unknown as { rewrite(): void }).rewrite = () => { current = page(table([...first, '| Write the announcement | Release tracker | open |']), current.version + 1, Date.now()); for (const listener of listeners) listener(); };

const items: AgentTimelineItem[] = [{ type: 'assistant_message', text: 'The tracker keeps the table; I will sum it up for you tonight.' } as unknown as AgentTimelineItem];
const state = createReplicaState();
const directory = (pages: () => readonly PageView[]): TaskDirectory => ({ canOpen: () => false, open: () => {}, owned: () => [], act: async () => {}, pages });

function Conversation() {
  const [, tick] = useState(0);
  listeners.add(() => tick(value => value + 1));
  return <TaskDirectoryContext.Provider value={directory(() => [current])}>
    <main style={{ width: 440, maxWidth: '100%' }} aria-label="Chief conversation"><ProcessModeContext.Provider value="concise">
      <AgentTimeline assistant={{ name: 'Chief of staff' }} state={{ ...state, agent: { ...(state.agent ?? {}), providerId: 'claude', id: 'agent', runtimeInfo: { sessionId: 'chief-session' } } as never, timeline: { ...state.timeline, epoch: 'e', initialized: true, entries: items.map((item, index) => ({
        providerId: 'claude', item, timestamp: '2026-11-28T10:00:00.000Z', seqStart: index + 1, seqEnd: index + 1, sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [] })) } }} />
    </ProcessModeContext.Provider></main></TaskDirectoryContext.Provider>;
}

function Details() {
  const sheet = new URLSearchParams(location.search).get('surface') === 'sheet';
  const [primary, setPrimary] = useState(false);
  const assistant = { id: ids.chief, name: 'Chief of staff', role: 'Coordinator', pages: [current, notes], primary: { current: primary, eligible: true, set: async (value: boolean) => { marks.push(value); setPrimary(value); } } };
  return sheet ? <AssistantDetails assistant={assistant} surface="sheet" onClose={() => {}} />
    : <aside aria-label="Details" style={{ width: 320, padding: 12 }} className="lab-assistant-details"><AssistantDetails assistant={assistant} surface="panel" onClose={() => {}} /></aside>;
}
const details = new URLSearchParams(location.search).get('view') === 'details';
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}>{details ? <Details /> : <Conversation />}</LocaleProvider>);
