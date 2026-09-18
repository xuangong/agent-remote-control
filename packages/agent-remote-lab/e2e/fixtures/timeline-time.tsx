import { createRoot } from 'react-dom/client';
import { createReplicaState } from '@agent-remote-controller/agent-remote-web';
import { AgentTimeline } from '@agent-remote-controller/agent-remote-web/react';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
import '@agent-remote-controller/agent-remote-web/styles.css';

const items: AgentTimelineItem[] = [
  { type: 'user_message', text: 'Please check the build.', messageId: 'user' },
  { type: 'assistant_message', text: 'I will check it now.\n\n[Open details](#details)\n\n```text\n' + 'scrollable-code '.repeat(30) + '\n```', messageId: 'assistant' },
  { type: 'tool_call', callId: 'sleep', name: 'clock.sleep', status: 'completed', detail: { type: 'other', description: 'Wait up to 15 seconds (requested)' }, error: null },
  { type: 'assistant_message', text: 'Missing timestamp', messageId: 'invalid' },
  ...Array.from({ length: 10 }, (_, i): AgentTimelineItem => ({ type: 'assistant_message', text: `More context ${i}. ` + 'Long task details. '.repeat(50), messageId: `long-${i}` })),
];
const state = createReplicaState();
createRoot(document.getElementById('root')!).render(<div style={{ height: '100dvh', overflow: 'auto' }} data-testid="scroll">
  <AgentTimeline showHeader={false} state={{ ...state, timeline: { ...state.timeline, epoch: 'time', initialized: true, entries: items.map((item, i) => ({
    providerId: 'codex', item, timestamp: i === 3 ? 'invalid' : '2026-09-18T02:11:17.158Z',
    seqStart: i + 1, seqEnd: i + 1, sourceSeqRanges: [{ startSeq: i + 1, endSeq: i + 1 }], collapsed: [], resources: [],
  })) } }} />
</div>);
