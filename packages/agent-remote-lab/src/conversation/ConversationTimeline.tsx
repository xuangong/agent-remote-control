// The timeline stage of a conversation: its tools and search, the scrolled entries with their reveal and reading position,
// and the empty and opening states. It renders again only when its own props change (the App render budgets check this).
import { memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sessionNoticeWords, type SessionNotice } from '@orchardworks/agent-client';
import { AgentTimeline, ProcessModeContext, TimelineLettersVisible, TimelineSearch, useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionTimelineTools } from '../components/SessionTimelineTools.js';
import { useTimelineScroll } from '../hooks/useTimelineScroll.js';
import type { SessionWorkbenchProps } from './session-workbench-props.js';

export const ConversationTimeline = memo(function ConversationTimeline({ nativeTakeover, readOnly, state, sessionStatus, attachingAgentId, visible, readingPositions, actions, revealEntry,
  notice, hasTarget, runtimeMutationDisabled, onInspectEntry, onOpenChildSession, childrenFor, resolveSessionLink,
  questionDrafts, onQuestionDraftChange, toolsTargetRef, toolsCollapsible, toolsScope, searchTriggerTarget, entrySelection, timelineStart, timelineEnd, loadingNotice, assistant }: Pick<SessionWorkbenchProps, 'readOnly' | 'state' | 'sessionStatus' | 'attachingAgentId' | 'visible' | 'actions' | 'revealEntry' | 'onInspectEntry' | 'onOpenChildSession' | 'childrenFor' | 'resolveSessionLink' | 'questionDrafts' | 'onQuestionDraftChange' | 'timelineStart' | 'timelineEnd' | 'entrySelection' | 'loadingNotice' | 'assistant'> & {
    readingPositions: NonNullable<Parameters<typeof useTimelineScroll>[2]>; toolsTargetRef(node: HTMLDivElement | null): void; toolsCollapsible: boolean; toolsScope?: string;
    /** The session's notice when it belongs above the timeline: refused, failed or unavailable. */
    notice?: SessionNotice;
    /** The view has a session to show, resolved or not: the empty state is only for a view with none. */
    hasTarget: boolean;
    /** A visible heading hosts the search trigger so it never covers Timeline content; null until it mounts. */
    searchTriggerTarget?: HTMLElement | null;
    runtimeMutationDisabled: boolean; nativeTakeover?: boolean;
  }) {
  const t = useTranslate();
  const searchScope = JSON.stringify([state?.agent?.id, state?.timeline.epoch]);
  const [openSearchScope, setOpenSearchScope] = useState<string>();
  const [searchSelection, setSearchSelection] = useState<{ scope: string; key: string; request: number }>();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchOpen = !!visible && !!state?.timeline.initialized && openSearchScope === searchScope;
  const selectedSearchKey = searchSelection?.scope === searchScope ? searchSelection.key : undefined;
  function closeSearch(options?: { restoreFocus?: boolean }) {
    setOpenSearchScope(undefined);
    setSearchSelection(undefined);
    if (options?.restoreFocus !== false) requestAnimationFrame(() => searchTrigger.current?.focus({ preventScroll: true }));
  }
  const display = useContext(ProcessModeContext);
  const lettersVisible = useContext(TimelineLettersVisible);
  useLayoutEffect(() => { setSearchSelection(undefined); }, [lettersVisible]);
  const contentRevision = useMemo(() => ({}), [state, display, lettersVisible, notice, questionDrafts, childrenFor]);
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined, contentRevision, 'bottom');
  const consumedReveal = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry) return;
    const request = JSON.stringify([state?.agent?.id, state?.timeline.epoch, revealEntry.requestId]);
    if (consumedReveal.current !== request && scroll.revealEntry(revealEntry.key, revealEntry.align)) consumedReveal.current = request;
  }, [visible, revealEntry, state?.agent?.id, state?.timeline.epoch, state?.timeline.entries, display, lettersVisible]);
  // The search panel floats over the top of the timeline. While it shows a chosen result, the timeline gets that much room
  // above its oldest entry, so that the result is revealed below the panel, the first one included. Opening the panel and
  // searching leave the reading position alone.
  const stage = useRef<HTMLDivElement>(null);
  const searchInset = () => {
    const panel = stage.current?.querySelector<HTMLElement>('.lab-timeline-controls > .agent-session-search');
    const timeline = scroll.viewportRef.current;
    if (!panel || !timeline) return 0;
    return Math.max(0, Math.ceil(panel.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top));
  };
  const applySearchInset = () => {
    const inset = searchOpen && selectedSearchKey ? searchInset() : 0;
    if (inset) stage.current?.style.setProperty('--lab-search-inset', `${inset}px`);
    else stage.current?.style.removeProperty('--lab-search-inset');
    return inset;
  };
  useLayoutEffect(() => {
    applySearchInset();
    const panel = stage.current?.querySelector('.lab-timeline-controls > .agent-session-search');
    if (!searchOpen || !selectedSearchKey || !panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { applySearchInset(); });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [searchOpen, selectedSearchKey]);
  useLayoutEffect(() => {
    if (visible && selectedSearchKey) scroll.revealEntry(selectedSearchKey, 'center', applySearchInset());
  }, [visible, selectedSearchKey, searchSelection?.request]);
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && hasTarget;
  const searchButton = state?.timeline.initialized ? <button ref={searchTrigger} type="button" className="lab-timeline-search-trigger" data-menu-close
    hidden={searchOpen && !searchTriggerTarget} aria-label={t('composer.view.search')} title={t('composer.view.search')} aria-expanded={searchOpen}
    onClick={() => { if (searchOpen) closeSearch(); else setOpenSearchScope(searchScope); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
  </button> : null;
  return <div ref={stage} className="lab-timeline-stage" onKeyDownCapture={event => {
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state?.timeline.initialized) {
        event.preventDefault(); event.stopPropagation(); setOpenSearchScope(searchScope);
      }
    }}>
      <SessionTimelineTools key={toolsScope} collapsible={toolsCollapsible} searchOpen={searchOpen} timelineRef={scroll.viewportRef} onDismissSearch={() => closeSearch({ restoreFocus: false })}
        searchPanel={searchOpen && state ? <TimelineSearch key={searchScope} state={state} search={actions.searchTimeline} onClose={closeSearch} onClearSelection={() => setSearchSelection(undefined)}
          onSelect={async (match, signal) => {
            if (actions.loadSearchMatch) await scroll.loadOlder(() => actions.loadSearchMatch!(match, { signal }));
            else if (!state.timeline.entries.some(entry => entry.seqStart === match.seq)) throw new Error(t('composer.view.searchLater'));
            signal.throwIfAborted();
            setSearchSelection(previous => ({ scope: searchScope, key: match.key, request: (previous?.request ?? 0) + 1 }));
          }} /> : null}>
      {searchTriggerTarget === undefined ? <>
        <div className="lab-timeline-session-tools" ref={toolsTargetRef} />
        {searchButton}
      </> : null}
      </SessionTimelineTools>
      {searchTriggerTarget && searchButton ? createPortal(searchButton, searchTriggerTarget) : null}
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {notice ? <p className="lab-control-note" role="alert">{sessionNoticeWords(notice, t)}</p> : null}
            <AgentTimeline
              state={state}
              assistant={assistant}
              onEditPrompt={actions.editPrompt}
              onRetryMessage={actions.retryMessage}
              onDeleteMessage={actions.deleteMessage}
              onInspectEntry={onInspectEntry}
              inspectedEntryKey={revealEntry?.key}
              inspectedRequestId={revealEntry?.requestId}
              searchEntryKey={selectedSearchKey}
              searchRequestId={searchSelection?.request}
              historyLoading={scroll.historyLoading}
              historyError={scroll.historyError}
              onOpenChildSession={onOpenChildSession}
              childrenFor={childrenFor}
              resolveSessionLink={resolveSessionLink}
              onLoadOlder={actions.loadOlder ? () => scroll.loadOlder(actions.loadOlder!) : undefined}
              onInteractionResponse={actions.respondToInteraction}
              interactionsReadOnly={readOnly}
              interactionsWaitingForConnection={!readOnly && (sessionStatus !== 'ready' || runtimeMutationDisabled)}
              interactionDisabled={sessionStatus !== 'ready' || runtimeMutationDisabled}
              onDownloadResource={actions.downloadResource}
              onResourceRequest={actions.requestResource}
              onResourceResolve={actions.resolveResource}
              questionDrafts={questionDrafts}
              onQuestionDraftChange={onQuestionDraftChange}
              entrySelection={entrySelection}
              timelineStart={timelineStart}
              timelineEnd={timelineEnd}
            />
          </> : nativeTakeover ? null : isAttaching ? <>
            {/* A conversation that is still opening shows nothing until its rows exist, unless something must be said (a Host that is away). */}
            {loadingNotice ? <div className="lab-empty-state">
              <span className="lab-empty-icon" aria-hidden="true">↗</span>
              <h3>{loadingNotice.title}</h3>
              <p>{loadingNotice.detail}</p>
            </div> : null}
            {/* What follows the conversation (messages waiting for an offline Host) shows before it loads too. */}
            {timelineEnd ? <div className="agent-timeline-entries lab-timeline-end">{timelineEnd}</div> : null}
          </> : <div className="lab-empty-state">
            <span className="lab-empty-icon" aria-hidden="true">↗</span>
            <h3>{t('composer.view.emptyTitle')}</h3>
            <p>{t('composer.view.emptyDetail')}</p>
          </div>}
        </div>
      </div>
      {scroll.showLatest ? <button className="lab-back-to-latest" type="button" onClick={scroll.scrollToLatest}>{t('composer.view.latest')} <span aria-hidden="true">↓</span></button> : null}
    </div>;
});
