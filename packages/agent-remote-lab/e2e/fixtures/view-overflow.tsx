import { createRoot } from 'react-dom/client';
import type { AgentInteractionRequest, AgentTimelineItem, AgentToolDetail } from '@agent-remote-controller/agent-remote-protocol';
import type { AgentReplicaState } from '@agent-remote-controller/agent-remote-web';
import { AgentCommandDetails, AgentTimeline } from '@agent-remote-controller/agent-remote-web/react';
import { App } from '../../src/App.js';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ReplicaInspector } from '../../src/components/ReplicaInspector.js';
import { TraceView } from '../../src/components/TraceView.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@agent-remote-controller/agent-remote-web/styles.css';

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
const fileChangeState: AgentReplicaState = { ...replicaState, timeline: {
  ...replicaState.timeline, hasOlder: false, entries: [{
    ...state.timeline.entries[0]!, resources: [], item: {
      type: 'tool_call', callId: 'file-change', name: 'file_change', status: 'completed', error: null,
      detail: { type: 'edit', filePath: `src/${long}/sample.ts` },
      result: { content: [{ type: 'json', value: { format: 'file_changes', version: 1, files: [
        { path: `src/${long}/sample.ts`, kind: 'modified', diff: `--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,2 @@\n-const old = true;\n+const text = "${long}";\n unchanged\n` },
        { path: 'added.txt', kind: 'added', diff: '@@ -0,0 +1,2 @@\n+first line\n+second line\n' },
        { path: 'deleted.txt', kind: 'deleted', diff: '@@ -1,1 +0,0 @@\n-old line\n' },
        { path: 'renamed.txt', previousPath: `src/${long}/old.txt`, kind: 'renamed', diff: '' },
        { path: 'image.png', kind: 'modified', diff: 'Binary files a/image.png and b/image.png differ' },
      ] } }] },
    },
  }],
} };
const previewItems: AgentTimelineItem[] = [
  { type: 'user_message', text: 'Please **fix the renderer**.' },
  { type: 'assistant_message', text: 'I found the failing assertion and updated the renderer.' },
  { type: 'reasoning', text: 'Check the existing event and preserve the original result.\nShow a short preview before opening the complete details.' },
  { type: 'tool_call', callId: 'preview-shell', name: 'command', status: 'completed', error: null,
    detail: { type: 'shell', command: 'pnpm test --filter renderer', cwd: '/workspace/project' },
    result: { content: [{ type: 'text', text: Array.from({ length: 30 }, (_, index) => index === 0 ? `PASS ${long}` : `Test result ${index}`).join('\n') }], exitCode: 0 } },
  { ...fileChangeState.timeline.entries[0]!.item, detail: { type: 'edit', filePath: 'src/renderer.tsx' },
    result: { content: [{ type: 'json', value: [{ path: 'src/renderer.tsx', diff: '@@ -1,2 +1,2 @@\n-old renderer\n+preview renderer\n unchanged' },
      { path: `src/${long}/mobile.tsx`, diff: '@@ -1 +1 @@\n-old\n+new' }] }] } } as AgentTimelineItem,
  { type: 'error', message: 'Optional catalog lookup timed out.\nThe session remains connected.\nRetry the catalog request to load available items.' },
  { type: 'interaction', request: { kind: 'question', requestId: 'preview-question', questions: [{ questionId: 'directory', header: 'Workspace',
    prompt: 'Which directory should be used for validation?', selection: 'single', required: true,
    options: [{ value: 'project', label: 'Current project' }], allowCustomText: true, allowDismiss: false }] },
    response: { kind: 'question', answers: [{ questionId: 'directory', selectedValues: ['project'] }] } },
];
const previewState: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false, entries: previewItems.map((item, index) => ({
  providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-15T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item,
})) } };
const planningItems: AgentTimelineItem[] = [
  { type: 'tool_call', callId: 'plan-update', name: 'functions.update_plan', status: 'completed', error: null,
    detail: { type: 'other', description: 'Update implementation plan' }, result: { content: [{ type: 'text', text: 'Plan updated' }] } },
  { type: 'todo', items: [{ text: 'Implement the view', completed: true, status: 'completed' },
    { text: 'Validate on mobile', completed: false, status: 'in_progress' }] },
  { type: 'interaction', request: { kind: 'plan_approval', requestId: 'content-plan', plan: 'Keep task progress visible.', allowedActions: ['approve'] },
    response: { kind: 'plan_approval', action: 'approve' } },
];
const contentState: AgentReplicaState = { ...previewState, timeline: { ...previewState.timeline, entries: [
  ...previewState.timeline.entries, ...planningItems.map((item, index) => ({
    providerId: 'recorded', seqStart: previewItems.length + index + 1, seqEnd: previewItems.length + index + 1,
    timestamp: '2026-09-18T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item,
  })),
] } };
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100dvh' }}>
    {view === 'previews' || view === 'content' ? <App initialState={view === 'content' ? contentState : previewState} initialSessionStatus="ready" /> : view === 'workbench' || view === 'tool-error' || view === 'file-changes' ? <LabWorkbench state={view === 'tool-error' ? failureState : view === 'file-changes' ? fileChangeState : state} sessionStatus="ready" actions={{ respondToInteraction: async () => {}, sendMessage: async () => {} }} />
      : view === 'trace' ? <TraceView state={state} />
      : view === 'inspector' ? <ReplicaInspector state={state} sessionStatus="ready" providerName={long} />
      : view === 'command' ? <AgentCommandDetails command={{ id: long, name: long, description: long, kind: 'skill', documentation: { resourceId: 'documentation', locator: 'SKILL.md', status: 'available' } }} resources={state.resources} onClose={() => {}} />
      : <AgentTimeline state={state} onInteractionResponse={async () => {}} />}
  </main>,
);
