import { createRoot } from 'react-dom/client';
import type { AgentInteractionRequest } from '@orchardworks/agent-remote-protocol';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

// A conversation with every kind of control a person answers or opens with a finger: a question with options, a permission, a plan
// and a form waiting for an answer, a file that can be loaded, and one already loaded that can be downloaded.
const requests: AgentInteractionRequest[] = [
  { kind: 'question', requestId: 'question', questions: [{ questionId: 'stack', header: 'Stack', prompt: 'Which stack?', selection: 'single', required: true,
    options: [{ value: 'stable', label: 'Stable (Recommended)' }, { value: 'edge', label: 'Edge' }], allowCustomText: true, allowDismiss: false }] },
  { kind: 'permission_approval', requestId: 'permission', summary: 'Read the project', permissions: [{ resource: 'filesystem', access: 'read', target: '/workspace/project' }], allowScopes: ['turn'] },
  { kind: 'plan_approval', requestId: 'plan', plan: 'Execute the verified plan.', allowedActions: ['approve_and_resume', 'reject'] },
  { kind: 'form', requestId: 'form', title: 'Connect a project', message: 'Details', fields: [{ type: 'text', fieldId: 'email', label: 'Contact email', required: true }] },
  { kind: 'external_action', requestId: 'external', title: 'Verify the connection', message: 'Continue in the browser', url: 'https://example.test/verify' },
];
const entry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], timestamp: '2026-09-22T09:00:00Z' };

createRoot(document.getElementById('root')!).render(<div className="lab-shell" style={{ display: 'block' }}><LabWorkbench state={{ ...replicaState,
  pendingInteractions: requests,
  resources: {
    loadable: { status: 'available', mediaType: 'text/plain', byteLength: 12, sha256: 'a'.repeat(64) },
    loaded: { status: 'available', mediaType: 'text/plain', byteLength: 12, sha256: 'b'.repeat(64), contentBase64: btoa('hello world\n') },
  },
  timeline: { ...replicaState.timeline, hasOlder: false, entries: [{ ...entry, resources: [
    { locator: 'artifacts/lab-proof.txt', resourceId: 'loadable', status: 'available' }, { locator: 'artifacts/loaded.txt', resourceId: 'loaded', status: 'available' },
  ], item: { type: 'assistant_message', text: 'Both files are ready.', messageId: 'files' } }] },
}} sessionStatus="ready" actions={{ sendMessage: async () => {}, respondToInteraction: async () => {} }} /></div>);
