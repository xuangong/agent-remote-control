// What a view says about the owner's pending input: unsent answers to questions, and how many inputs wait in the view.
import type { QuestionDraft } from '@orchardworks/agent-client-web/react';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import type { PresentationScope } from './scope.js';

export type OwnerInputContributionInputs = Pick<PresentationScope, 'questionDrafts' | 'setPendingGroupInputs' | 'setQuestionDrafts'>;

export const ownerInputContribution = ({ questionDrafts, setPendingGroupInputs, setQuestionDrafts }: OwnerInputContributionInputs) => ({ source }: SessionViewContext): SessionViewContribution => ({
  props: {
    questionDrafts: questionDrafts[source.agentId] ?? {},
    onQuestionDraftChange: (requestId: string, draft: QuestionDraft) => setQuestionDrafts(current => ({
      ...current, [source.agentId]: { ...current[source.agentId], [requestId]: draft },
    })),
    onPendingInputChange: (count: number) => setPendingGroupInputs(values => values[source.viewId] === count ? values : { ...values, [source.viewId]: count }),
  },
});
