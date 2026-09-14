import { createRoot } from 'react-dom/client';
import type { AgentInteractionRequest, AgentTimelineItem, AgentToolDetail } from '@borgee/agent-remote-protocol';
import type { AgentReplicaState } from '@borgee/agent-remote-web';
import { AgentCommandDetails, AgentTimeline } from '@borgee/agent-remote-web/react';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ReplicaInspector } from '../../src/components/ReplicaInspector.js';
import { TraceView } from '../../src/components/TraceView.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@borgee/agent-remote-web/styles.css';

const long = 'Unbroken0123456789'.repeat(40);
const markdown = `${long}\n\n[${long}](https://example.test/${long})\n\n\`${long}\`\n\n\`\`\`text\n${long}\n\`\`\`\n\n| ${Array(8).fill('Column').join(' | ')} |\n| ${Array(8).fill('---').join(' | ')} |\n| ${Array(8).fill(long).join(' | ')} |`;
const requests: AgentInteractionRequest[] = [
  { kind: 'question', requestId: 'question', questions: [{ questionId: 'choice', header: long, prompt: markdown, description: long, required: true, selection: 'single', options: [{ value: 'one', label: long, description: long }], allowCustomText: true, allowDismiss: true }] },
  { kind: 'plan_approval', requestId: 'plan', plan: markdown, allowedActions: ['approve', 'reject'] },
  { kind: 'tool_approval', requestId: 'tool', toolCallId: 'call', toolName: long, summary: long, detail: { type: 'shell', command: long, cwd: long }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] },
  { kind: 'permission_approval', requestId: 'permission', summary: long, permissions: [{ resource: 'filesystem', access: 'read', target: long }], allowScopes: ['turn'] },
  { kind: 'external_action', requestId: 'external', title: long, message: long, url: `https://example.test/${long}` },
  { kind: 'form', requestId: 'form', title: long, message: long, fields: [
    { type: 'text', fieldId: 'text', label: long, required: true },
    { type: 'select', fieldId: 'select', label: long, required: true, options: [{ value: 'one', label: long }] },
    { type: 'multiselect', fieldId: 'multi', label: long, required: false, options: [{ value: 'one', label: long }] },
  ] },
];
const details: AgentToolDetail[] = [
  { type: 'shell', command: long, cwd: long },
  ...(['read', 'edit', 'write'] as const).map(type => ({ type, filePath: long })),
  { type: 'search', query: long }, { type: 'fetch', url: `https://example.test/${long}` }, { type: 'other', description: long },
];
const items: AgentTimelineItem[] = [
  { type: 'user_message', text: markdown }, { type: 'assistant_message', text: markdown },
  { type: 'reasoning', text: markdown },
  ...details.map((detail, index): AgentTimelineItem => ({ type: 'tool_call', callId: `call-${index}`, name: long, detail, status: 'failed', error: long, result: { content: [{ type: 'text', text: long }, { type: 'json', value: { [long]: long } }] } })),
  { type: 'todo', items: [{ text: long, completed: false, status: 'in_progress' }] },
  { type: 'error', message: long }, { type: 'compaction', status: 'completed', trigger: 'auto' },
  { type: 'interaction', request: requests[0]!, response: { kind: 'question', answers: [{ questionId: 'choice', selectedValues: ['one'], customText: long }] } },
];
const state: AgentReplicaState = {
  ...replicaState,
  agent: { ...replicaState.agent!, id: long, providerId: long, runtimeInfo: {
    ...replicaState.agent!.runtimeInfo, sessionId: long, model: long, mode: long,
    childSessions: [{ nativeSessionId: long, title: long, description: long, status: 'waiting', observation: 'live', createdAt: '2026-09-15T00:00:00Z' }],
  } },
  timeline: { ...replicaState.timeline, epoch: long, hasOlder: false, entries: items.map((item, index) => ({
    providerId: long, seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-15T00:00:00Z', sourceSeqRanges: [], collapsed: [], item,
    resources: index === 1 ? (['pending', 'available', 'failed', 'unavailable'] as const).map(status => ({ resourceId: status, locator: `artifacts/${long}.txt`, status })) : [],
  })) },
  pendingInteractions: requests,
  resources: {
    documentation: { status: 'available', mediaType: 'text/markdown', byteLength: markdown.length, sha256: 'test', contentBase64: btoa(markdown) },
    available: { status: 'available', mediaType: 'text/plain', byteLength: 1, sha256: 'test', contentBase64: 'YQ==' },
    failed: { status: 'failed', message: long, retryable: false },
    unavailable: { status: 'unavailable', reason: long },
  },
  diagnostics: [{ code: 'protocol_violation', message: long, recoverable: true }],
};
const view = new URLSearchParams(location.search).get('view') ?? 'workbench';
const diffError = [
  'diff --git a/workspace/source/pnpm-lock.yaml b/workspace/build-source/pnpm-lock.yaml',
  'index fd9ab2bd..74261497 100644',
  '--- a/workspace/source/pnpm-lock.yaml',
  '+++ b/workspace/build-source/pnpm-lock.yaml',
  ...Array.from({ length: 20 }, (_, index) => `@@ -${361 + index},10 +${361 + index},6 @@ importers:\n     version: 5.9.3\n   packages/plugins/dsh:\n-    dependencies:\n-      '@deepseek-ai/dsh-session-projection':\n-        specifier: 0.1.2-rc.1`),
].join('\n');
const failureState: AgentReplicaState = { ...replicaState, timeline: {
  ...replicaState.timeline, hasOlder: false, entries: [{
    ...state.timeline.entries[0]!, resources: [], item: {
      type: 'tool_call', callId: 'failed-diff', name: 'command', status: 'failed', error: diffError,
      detail: { type: 'shell', command: "/bin/zsh -lc 'git diff --no-index /workspace/source/pnpm-lock.yaml /workspace/build-source/pnpm-lock.yaml'" },
    },
  }],
} };
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100dvh' }}>
    {view === 'workbench' || view === 'tool-error' ? <LabWorkbench state={view === 'tool-error' ? failureState : state} sessionStatus="ready" actions={{ respondToInteraction: async () => {}, sendMessage: async () => {} }} />
      : view === 'trace' ? <TraceView state={state} />
      : view === 'inspector' ? <ReplicaInspector state={state} sessionStatus="ready" providerName={long} />
      : view === 'command' ? <AgentCommandDetails command={{ id: long, name: long, description: long, kind: 'skill', documentation: { resourceId: 'documentation', locator: 'SKILL.md', status: 'available' } }} resources={state.resources} onClose={() => {}} />
      : <AgentTimeline state={state} onInteractionResponse={async () => {}} />}
  </main>,
);
