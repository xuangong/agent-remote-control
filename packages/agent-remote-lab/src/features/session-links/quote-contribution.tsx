// What quoting says about a session view: the message selection, the bar and notice that follow it, and the quotes waiting in the composer.
import type { TimelineEntrySelection } from '@orchardworks/agent-client-web/react';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import type { SessionExcerpt } from '@orchardworks/agent-remote-protocol';
import type { LabWorkbenchActions } from '../../conversation/LabWorkbench.js';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import type { OpenedSession } from '../../kernel/directory-client.js';
import type { QuoteEvent, QuoteNotice as QuoteNoticeState, QuoteSelection } from './quote-selection.js';
import { restoreQuotes } from './session-quotes.js';
import { QuoteAttachments, QuoteMessagesButton, QuoteNotice, QuoteSelectionBar, type QuoteTargetWindow } from './SessionQuotes.js';

export interface QuoteContributionInputs {
  baseUrl: string;
  quoteSelection: QuoteSelection | undefined;
  quoteNotice: QuoteNoticeState | undefined;
  dispatchQuote(event: QuoteEvent): void;
  quoteTargets(viewId: string, source: OpenedSession): QuoteTargetWindow[];
  quoteSelected(viewId: string, source: OpenedSession, state: AgentReplicaState, target: { windowId: string; viewId: string }): Promise<void>;
  quotedActions(base: LabWorkbenchActions, viewId: string): LabWorkbenchActions;
  quoteEntrySelection(viewId: string, epoch: string | null): TimelineEntrySelection;
}

export const quoteContribution = (inputs: QuoteContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { baseUrl, quoteSelection, quoteNotice, dispatchQuote, quoteTargets, quoteSelected, quotedActions, quoteEntrySelection } = inputs;
  const { context, source, quoteView } = view;
  if (!quoteView) return { composerStatus: null, composerContext: null };
  return {
    props: {
      ...(context.state ? { entrySelection: quoteEntrySelection(quoteView, context.state.timeline.epoch) } : {}),
      receiveQuotes: (excerpts: readonly SessionExcerpt[]) => restoreQuotes(baseUrl, quoteView, excerpts),
    },
    wrapActions: base => quotedActions(base, quoteView),
    composerStatus: <>
      {quoteSelection?.viewId === quoteView && context.state ? <QuoteSelectionBar count={quoteSelection.keys.size} windows={quoteTargets(quoteView, source)}
        busy={!!quoteSelection.busy} error={quoteSelection.error} onCancel={() => dispatchQuote({ type: 'cancel' })}
        onQuote={target => void quoteSelected(quoteView, source, context.state!, target)} /> : null}
      {quoteNotice?.viewId === quoteView ? <QuoteNotice message={quoteNotice.message} onDismiss={() => dispatchQuote({ type: 'notice.dismiss' })}
        onOpen={quoteNotice.open ? () => { const open = quoteNotice.open!; dispatchQuote({ type: 'notice.dismiss' }); void open().catch(() => {}); } : undefined} /> : null}
    </>,
    composerContext: <QuoteAttachments scope={baseUrl} viewId={quoteView} />,
  };
};

/** The heading action that starts selecting messages to quote, while no selection is under way in this view. */
export const quoteMessagesAction = (inputs: Pick<QuoteContributionInputs, 'quoteSelection' | 'quoteEntrySelection'>) => (view: SessionViewContext) => {
  const { quoteView, context } = view;
  return quoteView && context.state && inputs.quoteSelection?.viewId !== quoteView
    ? <QuoteMessagesButton onClick={() => inputs.quoteEntrySelection(quoteView, context.state!.timeline.epoch).select([], true)} /> : null;
};
