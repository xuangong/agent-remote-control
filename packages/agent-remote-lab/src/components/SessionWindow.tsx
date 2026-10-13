import { useRef, useState } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import type { DraftBinding } from '../draft-store.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionWindowId, type SessionWindowEntry } from '../hooks/useSessionWindows.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { SessionViewPlacement } from './SessionDock.js';
import { SessionFamily } from './SessionFamily.js';
import { AskResize } from './AskResize.js';

interface Props {
  entry: SessionWindowEntry; baseUrl: string; visible: boolean; compact: boolean; hostLabel: string; offline: boolean;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; navigation: SessionViewNavigationFactory;
  actions?: React.ReactNode;
  onClose(): void;
}

/** An ordinary session family can float or occupy one independently movable dock. */
export function SessionWindow(props: Props) {
  const [additionalWidth, setAdditionalWidth] = useState(0);
  return <SessionViewPlacement id={sessionWindowId(props.entry.target)} title={props.entry.target.title} visible={props.visible}
    dockRequest={props.entry.dockRequest} additionalWidth={additionalWidth}>
    {({ docked, controls }) => <WindowBody {...props} docked={docked} controls={controls} onAdditionalWidthChange={setAdditionalWidth} />}
  </SessionViewPlacement>;
}
function WindowBody({ entry, baseUrl, visible, compact, hostLabel, offline, transport, draftStore, navigation, docked, controls, actions, onClose, onAdditionalWidthChange }: Props & {
  docked: boolean; controls: React.ReactNode; onAdditionalWidthChange(width: number): void;
}) {
  const panel = useRef<HTMLElement>(null), anchor = useRef<HTMLSpanElement>(null);
  useAskPosition(panel, anchor, JSON.stringify([baseUrl, sessionWindowId(entry.target)]), { docked });
  return <>
    <span ref={anchor} />
    <div className="lab-ask-viewport" hidden={!visible}>
      <section ref={panel} className="lab-ask-window" aria-label={`Session: ${entry.target.title}`}>
        <SessionFamily storageScope={baseUrl} baseUrl={baseUrl} target={entry.target} hostLabel={hostLabel} offline={offline}
          active={visible} compact={compact} onAdditionalWidthChange={onAdditionalWidthChange}
          transport={transport} draftStore={draftStore} navigation={navigation}
          controls={<>{actions}{controls}<button type="button" aria-label={`Close ${entry.target.title}`} title="Close session view" onClick={onClose}>×</button></>} />
        <AskResize label={entry.target.title} />
      </section>
    </div>
  </>;
}
