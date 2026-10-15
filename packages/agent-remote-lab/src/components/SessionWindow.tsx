import { useRef, useState } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import type { ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { type SessionWindowEntry } from '../hooks/useSessionWindows.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { SessionViewPlacement, useRemoveSessionDocks } from './SessionDock.js';
import { SessionFamily } from './SessionFamily.js';
import { AskResize } from './AskResize.js';
import { sessionKey } from '../session-tree.js';

interface Props {
  entry: SessionWindowEntry; baseUrl: string; visible: boolean; compact: boolean; hostLabel: string; offline: boolean;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; navigation: SessionViewNavigationFactory;
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
function WindowBody({ entry, baseUrl, visible, compact, hostLabel, offline, transport, draftStore, draftBinding, imageDraftBinding, navigation, docked, controls, actions, onClose, onAdditionalWidthChange, selected, onFocus, onChangeSession }: Props & {
  docked: boolean; controls: React.ReactNode; onAdditionalWidthChange(width: number): void;
}) {
  const title = entry.target?.title ?? 'Select session';
  const panel = useRef<HTMLElement>(null), anchor = useRef<HTMLSpanElement>(null);
  useAskPosition(panel, anchor, JSON.stringify([baseUrl, entry.id]), { docked });
  const windowControls = <>{actions}{controls}{onChangeSession && entry.target ? <button type="button" aria-label="Change session" title="Choose a session from the sidebar" onClick={onChangeSession}>↔</button> : null}<button type="button" aria-label={`Close ${title}`} title="Close session view" onClick={onClose}>×</button></>;
  return <>
    <span ref={anchor} />
    <div className="lab-ask-viewport" hidden={!visible}>
      <section ref={panel} className="lab-ask-window lab-bindable-session-window" aria-label={`Session: ${title}`}
        data-view-id={entry.id} data-active={selected || undefined} tabIndex={-1}
        onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
        {entry.target ? <SessionFamily storageScope={baseUrl} baseUrl={baseUrl} target={entry.target} hostLabel={hostLabel} offline={offline}
          viewId={entry.slotId} nativePrefixOnly={entry.managed}
          displayBinding={{ scope: baseUrl, key: entry.id }} active={visible} compact={compact} onAdditionalWidthChange={onAdditionalWidthChange}
          transport={transport} draftStore={draftStore} draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} navigation={navigation} controls={windowControls} /> : <>
          <header className="lab-empty-session-heading"><strong>Select session</strong><div>{windowControls}</div></header>
          <div className="lab-empty-session-body"><p>Choose a session from the sidebar</p>
            <button type="button" onClick={onChangeSession}>Open sidebar</button></div>
        </>}
        <AskResize label={title} />
      </section>
    </div>
  </>;
}
