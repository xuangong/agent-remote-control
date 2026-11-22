// What a view says about the sessions behind it: where its conversation starts, and where an attribution leads.
import type { SessionAttribution, Translate } from '@orchardworks/agent-client';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import type { PresentationScope } from './scope.js';

export type EarlierSessionsContributionInputs = Pick<PresentationScope, 'earlierConversationFor' | 'navigation' | 'succession'> & { t: Translate };

export const earlierSessionsContribution = ({ earlierConversationFor, navigation, succession, t }: EarlierSessionsContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { botPresentation, windowBot, source } = view;
  return {
    props: {
      // Bot mode does not announce a handoff: the conversation continues into the earlier sessions instead of linking to them.
      timelineStart: botPresentation || windowBot ? earlierConversationFor(succession.historyNavigationFor(source)) : undefined,
      onNavigateAttribution: botPresentation ? async (attribution: SessionAttribution) => {
        if (!attribution.target) return;
        if (attribution.target.kind === 'group') throw new Error(t('sessions.presentation.openInWindow'));
        navigation.select({ kind: 'session', session: { ...attribution.target, title: attribution.value } });
      } : undefined,
    },
  };
};
