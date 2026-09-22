import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentInteractionRequest, AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const command = '"C:\\WINDOWS\\system32\\cmd.exe" /c curl.exe -L --fail --max-time 20 https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/tui/src/chatwidget.rs -o .tmp/chatwidget.rs';
const request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }> = {
  kind: 'tool_approval', requestId: 'approval', toolCallId: 'command', toolName: 'command',
  summary: '网络沙箱阻止读取 Codex 官方源码；是否允许下载当前版本的 CLI 实现，确认 Full Access 是立即同步还是到下一轮才生效？',
  detail: { type: 'shell', command, cwd: 'C:\\Users\\xanzh\\projects\\agent-remote-control\\.worktrees\\shared-permissions' },
  context: [{ label: 'Environment', value: 'local' }],
  allowedDecisions: ['allow', 'cancel'], allowScopes: ['once', 'policy'],
  policies: [{ policyId: 'command-prefix', description: `Allow command prefix ${JSON.stringify(['C:\\WINDOWS\\system32\\cmd.exe', '/c', command])} for future commands` }],
};

function Fixture() {
  const [response, setResponse] = useState<Extract<AgentTimelineItem, { type: 'interaction' }>['response']>();
  const item: AgentTimelineItem = response ? { type: 'interaction', request, response }
    : { type: 'assistant_message', text: '先确认当前版本的权限同步行为，再决定修改方式。' };
  return <div className="lab-shell" style={{ display: 'block' }}><LabWorkbench state={{ ...replicaState,
    pendingInteractions: response ? [] : [request],
    timeline: { ...replicaState.timeline, hasOlder: false, entries: [{
      providerId: 'codex', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], resources: [],
      timestamp: '2026-09-22T09:00:00Z', item,
    }] },
  }} sessionStatus="ready" actions={{ sendMessage: async () => {}, respondToInteraction: async (_id, response) => setResponse(response) }} /></div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
