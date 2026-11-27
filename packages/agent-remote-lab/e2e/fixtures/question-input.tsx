import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import type { QuestionDraft } from '@orchardworks/agent-client-web/react';
import { LabWorkbench } from '../../src/conversation/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

const question: AgentInteractionRequest = {
  kind: 'question', requestId: 'question',
  questions: [{ questionId: 'directory', header: 'Workspace', prompt: 'Which directory should be used?', required: true, selection: 'single',
    options: [{ value: 'project', label: 'Current project' }], allowCustomText: true, allowDismiss: false }],
};
const form: AgentInteractionRequest = {
  kind: 'form', requestId: 'form', title: 'Details', message: 'Tell the assistant more.',
  fields: [{ type: 'text', fieldId: 'note', label: 'Note', required: true }],
};

const plan: AgentInteractionRequest = { kind: 'plan_approval', requestId: 'plan', plan: 'Rename the module.', allowedActions: ['approve', 'reject'] };

declare global { interface Window { answers: AgentInteractionResponse[] } }
window.answers = [];

// Holds the drafts the way a conversation does: one record per request, which the owner hands back after the event that changed it
// (the application publishes a view's props to its conversation after a render of its own).
function Fixture() {
  const [drafts, setDrafts] = useState<Readonly<Record<string, QuestionDraft>>>({});
  // The drafts live here, so a remount of the workbench (as a timeline re-render does to a card) starts from what the owner kept.
  const [generation, setGeneration] = useState(0);
  return <div className="lab-shell" style={{ display: 'block' }}><button type="button" data-testid="remount" onClick={() => setGeneration(value => value + 1)}>Remount</button><LabWorkbench key={generation} state={{ ...replicaState,
    pendingInteractions: [question, form, plan],
    timeline: { ...replicaState.timeline, hasOlder: false, entries: Array.from({ length: 30 }, (_, index) => ({
      providerId: 'codex', seqStart: index + 1, seqEnd: index + 1, sourceSeqRanges: [], collapsed: [], resources: [],
      timestamp: '2026-09-22T09:00:00Z', item: index % 2 ? { type: 'assistant_message' as const, text: `Earlier answer ${index}.` } : { type: 'user_message' as const, text: `Earlier request ${index}.` },
    })) },
  }} sessionStatus="ready" questionDrafts={drafts} onQuestionDraftChange={(id, draft) => { setTimeout(() => setDrafts(current => ({ ...current, [id]: draft })), 0); }}
  actions={{ sendMessage: async () => {}, respondToInteraction: async (_id, response) => { window.answers.push(response); } }} /></div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
