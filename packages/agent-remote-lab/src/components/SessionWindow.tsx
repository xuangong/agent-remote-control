import { useContext, useRef, useState, type ComponentProps } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import type { ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { type SessionWindowEntry } from '../hooks/useSessionWindows.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { SessionViewPlacement, useRemoveSessionDocks } from './SessionDock.js';
import { SessionFamily } from './SessionFamily.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { AskResize } from './AskResize.js';
import { sessionKey } from '../session-tree.js';
import { useWindowLayout } from '../window-workspace-context.js';

interface Props {
  entry: SessionWindowEntry; baseUrl: string; visible: boolean; compact: boolean; hostLabel: string; offline: boolean;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; navigation: SessionViewNavigationFactory;
  onSessionBound?: ComponentProps<typeof SessionFamily>['onSessionBound'];
  sessionPresentation?: ComponentProps<typeof SessionFamily>['sessionPresentation'];
  renderSessionFooter?: ComponentProps<typeof SessionFamily>['renderSessionFooter'];
  actions?: React.ReactNode; selected?: boolean; closeWith?: string[];
  onFocus(): void; onChangeSession?(): void;
  onClose(): void;
}

/** An ordinary session family can float or occupy one independently movable dock. */
export function SessionWindow(props: Props) {
  const removeDocks = useRemoveSessionDocks();
  const close = () => { removeDocks([props.entry.id, ...(props.closeWith ?? [])]); props.onClose(); };
  const [additionalWidth, setAdditionalWidth] = useState(0);
  return <SessionViewPlacement id={props.entry.id} title={props.entry.target?.title ?? 'Select session'} visible={props.visible}
    dockRequest={props.entry.dockRequest} additionalWidth={additionalWidth}>
    {({ docked, controls }) => <WindowBody {...props} onClose={close} docked={docked} controls={controls} onAdditionalWidthChange={setAdditionalWidth} />}
  </SessionViewPlacement>;
}
function WindowBody({ entry, baseUrl, visible, compact, hostLabel, offline, transport, draftStore, draftBinding, imageDraftBinding, navigation, docked, controls, actions, onClose, onAdditionalWidthChange, selected, onFocus, onChangeSession, onSessionBound, sessionPresentation, renderSessionFooter }: Props & {
  docked: boolean; controls: React.ReactNode; onAdditionalWidthChange(width: number): void;
}) {
  const shared = useWindowLayout();
  const titleInteraction = useContext(SessionTitleInteractionContext);
  const title = entry.target?.title ?? 'Select session';
  const panel = useRef<HTMLElement>(null), anchor = useRef<HTMLSpanElement>(null);
  useAskPosition(panel, anchor, JSON.stringify([baseUrl, entry.id]), { docked });
  const focusWindow = (event: { target: EventTarget }) => {
    if (shared && event.target instanceof Element && event.target.closest('.lab-session-family-pane')) return;
    onFocus();
  };
  const menuActions = controls || onChangeSession && entry.target ? <>{controls}{onChangeSession && entry.target ? <button type="button" aria-label="Change session" title="Choose a session from the sidebar" onClick={onChangeSession}>↔</button> : null}</> : undefined;
  const windowControls = <>{actions}<button type="button" aria-label={`Close ${title}`} title="Close session view" onClick={onClose}>×</button></>;
  return <>
    <span ref={anchor} />
    <div className="lab-ask-viewport" hidden={!visible}>
      <section ref={panel} className="lab-ask-window lab-bindable-session-window lab-session-pane-selection" aria-label={`Session: ${title}`}
        data-view-id={entry.id} data-active={selected || undefined} tabIndex={-1}
        data-selected={!entry.target && selected || undefined} aria-current={!entry.target && selected ? 'true' : undefined}
        onPointerDownCapture={focusWindow} onFocusCapture={focusWindow}>
        {entry.target ? <SessionFamily storageScope={baseUrl} baseUrl={baseUrl} target={entry.target} hostLabel={hostLabel} offline={offline}
          viewId={shared ? entry.id : entry.slotId} sessionIntent={shared?.window.views.find(view => view.id === entry.id)?.binding?.sessionIntent}
          onSessionBound={onSessionBound} sessionPresentation={sessionPresentation} renderSessionFooter={renderSessionFooter} nativePrefixOnly={entry.managed}
          displayBinding={{ scope: baseUrl, key: entry.id }} active={visible} compact={compact} onAdditionalWidthChange={onAdditionalWidthChange}
          transport={transport} draftStore={draftStore} draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} navigation={navigation} controls={windowControls} menuActions={menuActions} /> : <>
          <header className="lab-empty-session-heading"><strong {...titleInteraction}>Select session</strong><div>{menuActions ? <SessionHeadingActions sessionKey={entry.id} alwaysCollapsed>{menuActions}</SessionHeadingActions> : null}{windowControls}</div></header>
          <div className="lab-empty-session-body"><p>Choose a session from the sidebar</p>
            <button type="button" onClick={onChangeSession}>Open sidebar</button></div>
        </>}
        <AskResize label={title} />
      </section>
    </div>
  </>;
}
