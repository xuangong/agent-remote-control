import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { remoteSessionState } from '@orchardworks/agent-client';
import { TimelineRows } from '@orchardworks/agent-client/testing';
import { AgentComposer, AgentTimeline, ProcessModeContext, TaskDirectoryContext, type AskLine, type TaskDirectory } from '@orchardworks/agent-client-web/react';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';

// One conversation with a turn, the composer under it, and two bots to mention. The ask the page makes is recorded for the spec to read.
const rows = new TimelineRows('recorded', Date.parse('2026-11-24T10:00:00Z'));
rows.user('Can you summarise the release notes?', { key: 'p1', turnId: 't1' });
rows.assistant('The notes cover three fixes and one new command.', { key: 'a1', turnId: 't1' });
const answered: AskLine = { id: 'one', botId: 'b_1', bot: 'Reviewer', text: 'Is the third fix safe to ship on Friday?', at: Date.parse('2026-11-24T10:00:05Z'),
  answer: { text: 'Yes. The third fix only touches the retry timer and has a test. Ship it, and watch the first hour of retries.', at: Date.parse('2026-11-24T10:00:30Z') } };
const answering: AskLine = { id: 'two', botId: 'b_2', bot: 'Release Manager', text: 'Who signs off the release?', at: Date.parse('2026-11-24T10:01:00Z') };
const state = { ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities,
  imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } },
  timeline: { ...replicaState.timeline, hasOlder: false, entries: rows.entries, nextSeq: rows.entries.length + 1 } };
const asked: Array<[string, string]> = [];
(window as unknown as { asked: typeof asked }).asked = asked;
const directory: TaskDirectory = { canOpen: () => false, open: () => {}, owned: () => [], act: async () => {}, asks: () => [answered, answering],
  bots: () => [{ botId: 'b_1', name: 'Reviewer' }, { botId: 'b_2', name: 'Release Manager' }],
  ask: async (_source, bot, text) => { asked.push([bot.name, text]); } };

function Fixture() {
  const [draft, setDraft] = useState('');
  return <TaskDirectoryContext.Provider value={directory}><ProcessModeContext.Provider value="concise">
    <main style={{ width: 'min(480px, 100%)', margin: '0 auto' }} aria-label="Conversation">
      <AgentTimeline state={state} />
      <AgentComposer sessionState={remoteSessionState(state, 'ready')} state={state} sessionKey="mention-fixture" draft={draft} onDraftChange={setDraft}
        imageDraftBinding={{ scope: 'fixture', key: 'view:mention' }} onSendMessage={async text => { asked.push(['session', text]); }}
        mentions={{ bots: directory.bots!(), ask: (bot, text) => directory.ask!({ hostId: 'mac', providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Notes' }, bot, text) }} />
    </main>
  </ProcessModeContext.Provider></TaskDirectoryContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
