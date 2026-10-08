import { createRoot } from 'react-dom/client';
import { createReplicaState } from '@orchardworks/agent-remote-web';
import { AgentTimeline, TimelineDisplay } from '@orchardworks/agent-remote-web/react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import '@orchardworks/agent-remote-web/styles.css';

const description = 'Read the source session conversation, including the latest messages and tool activity, to explain the current implementation and verification results. Return enough context to answer the question without changing the source session.';
const items: AgentTimelineItem[] = [
  { type: 'tool_call', callId: 'activity', name: 'agent.activity', status: 'completed', detail: { type: 'other', description: 'Agent /root/verify_sdk_boundary: started' }, error: null },
  { type: 'tool_call', callId: 'source', name: 'read_source_session', status: 'running', detail: { type: 'other', description }, error: null },
  { type: 'tool_call', callId: 'linked', name: 'agent.activity', status: 'completed', detail: { type: 'other', description: 'Agent /root/verify_sdk_boundary: started', sessionReference: { nativeSessionId: 'child', title: '/root/verify_sdk_boundary' } }, error: null },
  { type: 'tool_call', callId: 'wait', name: 'agent.wait', status: 'running', detail: { type: 'other', description: 'Waiting for agent updates:', sessionReferences: [{ nativeSessionId: 'child', title: '/root/verify_sdk_boundary' }, { nativeSessionId: 'review', title: '/root/review' }] }, error: null },
];
const state = createReplicaState();

createRoot(document.getElementById('root')!).render(
  <main style={{ width: 440, maxWidth: '100%' }} aria-label="Tool timeline">
    <TimelineDisplay.Provider value="simple">
      <AgentTimeline showHeader={false} resolveSessionLink={nativeSessionId => ({ href: `#${nativeSessionId}`, async open() { location.hash = nativeSessionId; } })} state={{ ...state, timeline: {
        ...state.timeline, epoch: 'layout', initialized: true, entries: items.map((item, index) => ({
          providerId: 'codex', item, timestamp: '2026-10-08T02:11:17.158Z',
          seqStart: index + 1, seqEnd: index + 1, sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
        })),
      } }} />
    </TimelineDisplay.Provider>
  </main>,
);
