import { useContext, useRef, useState, type ComponentProps } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import type { ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { type SessionWindowEntry } from '../hooks/useSessionWindows.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { FoldedBotCard, SessionViewPlacement, useRemoveSessionDocks, type FoldedBot } from './SessionDock.js';
import { SessionFamily } from './SessionFamily.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { AskResize } from './AskResize.js';
import { MissingSessionNote } from './SessionConnectionNotice.js';
import { sessionKey } from '../session-tree.js';
import { useWindowLayout } from '../window-workspace-context.js';

interface Props {
  entry: SessionWindowEntry; baseUrl: string; visible: boolean; compact: boolean; hostLabel: string; offline: boolean;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; navigation: SessionViewNavigationFactory;
  onSessionBound?: ComponentProps<typeof SessionFamily>['onSessionBound'];
  /** The Host confirmed that the bound session no longer exists, so the view shows as empty. */
  missing?: boolean;
  onSessionUnavailable?: ComponentProps<typeof SessionFamily>['onSessionUnavailable'];
  sessionPresentation?: ComponentProps<typeof SessionFamily>['sessionPresentation'];
  renderSessionFooter?: ComponentProps<typeof SessionFamily>['renderSessionFooter'];
  actions?: React.ReactNode; selected?: boolean; closeWith?: string[];
  onFocus(): void; onChangeSession?(): void;
  onClose(): void;
  /** A folded bot (desktop): the pane stands as a slim card and its conversation is released. */
  fold?: FoldedBot;
  /** × folds the pane where it stands instead of closing it: a bot stays in its group. */
  onFold?(): void;
  onRestore?(): void;
  /** The folded card's ×: removing the bot from its group, after a confirmation. */
  onRemove?(): void;
  /** Closing a view attached in this family; a bot's Side folds instead. */
  onCloseView?: ComponentProps<typeof SessionFamily>['onCloseView'];
}

/** An ordinary session family can float or occupy one independently movable dock. */
export function SessionWindow(props: Props) {
  const removeDocks = useRemoveSessionDocks();
  // A bot's pane folds where it stands; any other view leaves its dock and closes.
  const close = props.onFold ?? (() => { removeDocks([props.entry.id, ...(props.closeWith ?? [])]); props.onClose(); });
  const [additionalWidth, setAdditionalWidth] = useState(0);
  return <SessionViewPlacement id={props.entry.id} title={props.entry.target && !props.missing ? props.entry.target.title : 'Select session'} visible={props.visible}
    dockRequest={props.entry.dockRequest} additionalWidth={additionalWidth} folded={!!props.fold}>
    {({ docked, controls }) => <WindowBody {...props} onClose={close} docked={docked} controls={controls} onAdditionalWidthChange={setAdditionalWidth} />}
  </SessionViewPlacement>;
}
function WindowBody({ entry, baseUrl, visible, compact, hostLabel, offline, transport, draftStore, draftBinding, imageDraftBinding, navigation, docked, controls, actions, onClose, onAdditionalWidthChange, selected, onFocus, onChangeSession, onSessionBound, sessionPresentation, renderSessionFooter, missing, onSessionUnavailable, fold, onFold, onRestore, onRemove, onCloseView }: Props & {
  docked: boolean; controls: React.ReactNode; onAdditionalWidthChange(width: number): void;
}) {
  const shared = useWindowLayout();
  const titleInteraction = useContext(SessionTitleInteractionContext);
  const target = missing ? undefined : entry.target;
  const title = target?.title ?? 'Select session';
  const panel = useRef<HTMLElement>(null), anchor = useRef<HTMLSpanElement>(null);
  useAskPosition(panel, anchor, JSON.stringify([baseUrl, entry.id]), { docked });
  const focusWindow = (event: { target: EventTarget }) => {
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore]')) return;
    if (shared && event.target instanceof Element && event.target.closest('.lab-session-family-pane')) return;
    onFocus();
  };
  const menuActions = controls || onChangeSession && target ? <>{controls}{onChangeSession && target ? <button type="button" aria-label="Change session" title={compact ? 'Choose a session from the sidebar' : 'Choose a session from All sessions'} onClick={onChangeSession}>↔</button> : null}</> : undefined;
  const windowControls = <>{actions}<button type="button" aria-label={`Close ${title}`} title={onFold ? 'Fold. It stays in this group.' : 'Close session view'} onClick={onClose}>×</button></>;
  return <>
    <span ref={anchor} />
    <div className="lab-ask-viewport" hidden={!visible}>
      <section ref={panel} className="lab-ask-window lab-bindable-session-window lab-session-pane-selection" aria-label={`Session: ${title}`}
        data-view-id={entry.id} data-active={selected || undefined} data-folded={fold ? true : undefined} tabIndex={-1}
        data-selected={!target && selected || undefined} aria-current={!target && selected ? 'true' : undefined}
        onPointerDownCapture={focusWindow} onFocusCapture={event => {
          // Safari can focus this container when a focused child control is tapped.
          // An already selected family's container must retain its selected Side.
          if (shared && target && selected && event.target === event.currentTarget) return;
          focusWindow(event);
        }}>
        {/* Folded, the conversation stays mounted but unseen and released; the slim card stands in for it. */}
        {fold ? <>
          <button type="button" data-pane-selection-ignore className="lab-folded-remove" aria-label={`Remove ${title} from this group`} title="Remove from group…" onClick={onRemove}>×</button>
          <FoldedBotCard label={`Restore ${title}`} fold={fold} onRestore={() => onRestore?.()} />
        </> : null}
        {target ? <SessionFamily folded={!!fold} onCloseView={onCloseView} storageScope={baseUrl} baseUrl={baseUrl} target={target} hostLabel={hostLabel} offline={offline}
          viewId={shared ? entry.id : entry.slotId} sessionIntent={shared?.window.views.find(view => view.id === entry.id)?.binding?.sessionIntent}
          onSessionBound={onSessionBound} onSessionUnavailable={onSessionUnavailable} sessionPresentation={sessionPresentation} renderSessionFooter={renderSessionFooter}
          displayBinding={{ scope: baseUrl, key: entry.id }} active={visible} compact={compact} onAdditionalWidthChange={onAdditionalWidthChange}
          transport={transport} draftStore={draftStore} draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} navigation={navigation} controls={windowControls} menuActions={menuActions} /> : <>
          <header className="lab-empty-session-heading"><strong {...titleInteraction}>Select session</strong><div>{menuActions ? <SessionHeadingActions sessionKey={entry.id} alwaysCollapsed>{menuActions}</SessionHeadingActions> : null}{windowControls}</div></header>
          <div className="lab-empty-session-body">{entry.target ? <MissingSessionNote title={entry.target.title} host={hostLabel} /> : null}<p>{compact ? 'Choose a session from the sidebar' : 'Choose a session from All sessions'}</p>
            <button type="button" onClick={onChangeSession}>{compact ? 'Open sidebar' : 'Choose session'}</button></div>
        </>}
        <AskResize label={title} />
      </section>
    </div>
  </>;
}
