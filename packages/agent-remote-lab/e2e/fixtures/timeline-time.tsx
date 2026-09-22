import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createReplicaState } from '@orchardworks/agent-remote-web';
import { AgentTimeline } from '@orchardworks/agent-remote-web/react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import '@orchardworks/agent-remote-web/styles.css';

const items: AgentTimelineItem[] = [
  { type: 'user_message', text: 'Please check the build.', messageId: 'user' },
  { type: 'assistant_message', text: 'I will check it now.\n\n[Open details](#details)\n\n```text\n' + 'scrollable-code '.repeat(30) + '\n```', messageId: 'assistant' },
  { type: 'tool_call', callId: 'sleep', name: 'clock.sleep', status: 'completed', detail: { type: 'other', description: 'Wait up to 15 seconds (requested)' }, error: null },
  { type: 'assistant_message', text: 'Missing timestamp', messageId: 'invalid' },
  { type: 'tool_call', callId: 'wait', name: 'agent.wait', status: 'completed', detail: { type: 'other', description: 'Wait for', sessionReference: { nativeSessionId: 'research', title: '/root/research' } }, error: null },
  { type: 'reasoning', text: 'Check the output.' },
  { type: 'error', message: 'Example diagnostic' },
  ...Array.from({ length: 10 }, (_, i): AgentTimelineItem => ({ type: 'assistant_message', text: `More context ${i}. ` + 'Long task details. '.repeat(50), messageId: `long-${i}` })),
];
const state = createReplicaState();
function Fixture() {
  const [updated, setUpdated] = useState(false);
  const [side, setSide] = useState(false);
  const editable = new URLSearchParams(location.search).has('edit');
  const [edits, setEdits] = useState(0);
  const [inspections, setInspections] = useState(0);
  return <div style={{ height: '100dvh', overflow: 'auto' }} data-testid="scroll">
  {editable ? <output data-testid="edits">{edits}</output> : null}
  {editable ? <output data-testid="inspections">{inspections}</output> : null}
  <button onClick={() => setUpdated(true)}>Update message</button>
  <button onClick={() => setSide(true)}>Open Side conversation</button>
  {side ? <AgentTimeline showHeader={false} state={{ ...state, timeline: { ...state.timeline, epoch: 'side', initialized: true, entries: [{
    providerId: 'codex', item: { type: 'assistant_message', messageId: 'side', text: 'Side conversation' }, timestamp: '2026-09-18T02:11:17.158Z',
    seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
  }] } }} /> : null}
  <AgentTimeline onInspectEntry={editable ? () => setInspections(value => value + 1) : undefined} onEditPrompt={editable ? async () => { setEdits(value => value + 1); } : undefined} resolveSessionLink={() => ({ href: "#research", async open() { location.hash = "research"; } })} showHeader={false} state={{ ...state, timeline: { ...state.timeline, epoch: 'time', initialized: true, entries: items.map((item, i) => ({
    providerId: 'codex', item: updated && item.type === 'assistant_message' && item.messageId === 'assistant' ? { ...item, text: item.text + '\n\nStreaming update' } : item, timestamp: i === 3 ? 'invalid' : '2026-09-18T02:11:17.158Z',
    turnId: 'turn-' + i, seqStart: i + 1, seqEnd: i + 1, sourceSeqRanges: [{ startSeq: i + 1, endSeq: i + 1 }], collapsed: [], resources: [],
  })) } }} />
</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
