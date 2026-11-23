// What a view says about its heading: the session manager with its close, star, history and link actions, and the title with its rename.
import type { Translate } from '@orchardworks/agent-client';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { SessionHeadingActions } from '../../conversation/SessionHeadingActions.js';
import { SessionTitle } from '../../conversation/SessionTitle.js';
import { ChatSessionManager } from '../../features/sessions/ChatSessionManager.js';
import { StarButton } from '../../features/sessions/SessionFavorites.js';
import { quoteMessagesAction, type QuoteContributionInputs } from '../../features/session-links/quote-contribution.js';
import { IconButton } from '../../ui/IconButton.js';
import { SessionLink } from '../../kernel/SessionLink.js';
import { sessionKey } from '../../kernel/session-tree.js';
import { windowSessionBinding } from '../../kernel/window-workspace.js';
import type { PresentationScope } from './scope.js';

export type HeadingActionsContributionInputs = Pick<PresentationScope, 'baseUrl' | 'compactLayout' | 'conversationHistory' | 'directory' | 'favorites' | 'openLocalView' | 'openSession' | 'sessionEntries' | 'setRenamingSession' | 'sharedWindow' | 'succession' | 'userScoped'>
  & Pick<QuoteContributionInputs, 'quoteSelection' | 'quoteEntrySelection'>
  & { t: Translate; foldsOnClose(view: SessionViewContext['view']): boolean; closeView(viewId: string): void };

export const headingActionsContribution = (inputs: HeadingActionsContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { baseUrl, compactLayout, conversationHistory, directory, favorites, openLocalView, openSession, sessionEntries, setRenamingSession, sharedWindow, succession, userScoped, t, foldsOnClose, closeView } = inputs;
  const { context, botPresentation, source, view: windowView, isPrimary, host, available, openBot } = view;
  if (botPresentation) return { props: { sessionManager: undefined, conversationPath: undefined } };
  const mayRename = userScoped && host?.online && host.access !== 'shared' && host.providers?.some(provider => provider.providerId === source.providerId && provider.sessionRename);
  return {
    props: {
      sessionManager: <>{context.controls}{isPrimary ? <IconButton icon="close" data-pane-selection-ignore label={t('sessions.presentation.closeGroup', { title: source.title })}
        title={foldsOnClose(windowView) ? t('sessions.presentation.fold') : t('sessions.presentation.closeView')}
        onClick={() => closeView(windowView!.id)} /> : null}
        {!compactLayout ? <StarButton session={source} favorites={favorites} /> : null}
        <SessionHeadingActions sessionKey={sessionKey(source)} alwaysCollapsed={!!context.menuActions}>
          {context.menuActions}
          {isPrimary && (!compactLayout || succession.localViews().length > 0) && directory ? <ChatSessionManager current={source} entries={sessionEntries} busy={false}
            localViews={succession.localViews()} activeSlot={context.viewId} onOpenView={opened => void openLocalView(opened.slotId)}
            onOpen={item => void openSession(item, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary', windowView!.id)} /> : null}
          {isPrimary && windowView!.id === sharedWindow?.selectedPrimaryViewId ? <nav className="lab-conversation-history" aria-label={t('sessions.presentation.history')}>
            <button type="button" aria-label={t('sessions.presentation.backToPrevious')} title={t('sessions.side.back')} disabled={!conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label={t('sessions.presentation.forwardToNext')} title={t('sessions.presentation.forward')} disabled={!conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav> : null}
          <SessionLink session={available ? source : windowSessionBinding(source)} sessionIntent={context.operationBinding.historical ? 'history' : undefined} />
          {openBot ? <button type="button" className="lab-open-in-bot" onClick={openBot}>{t('card.openInBot')}</button> : null}
          {quoteMessagesAction(inputs)(view)}
        </SessionHeadingActions></>,
      conversationPath: <SessionTitle className={isPrimary ? 'lab-primary-title' : undefined} title={source.title} status={context.state?.agent?.status}
        onRename={mayRename ? () => setRenamingSession({ scope: baseUrl, session: { ...source, hostId: source.hostId ?? 'local' } }) : undefined} />,
    },
  };
};
