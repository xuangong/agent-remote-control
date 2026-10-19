import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { isAskAttached, askParticipantKey, type AskEntry, type AskInput, type AskInputSender } from '../hooks/useAskConversations.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { SessionFork } from '../session-forks.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { askCommand } from '../fork-actions.js';
import { SessionFamily } from './SessionFamily.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { SessionLink } from './SessionLink.js';
import { SessionViewPlacement } from './SessionDock.js';
import { AskResize } from './AskResize.js';
import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { useWindowLayout, WindowPresentationContext } from '../window-workspace-context.js';
interface AskStorageBindings { baseUrl?: string; viewId?: string; compact?: boolean; imageDraftBinding?: ImageDraftBinding; imageRecipient?: ImageDraftRecipient; displayBinding?: DisplayPreferenceBinding }

export function AskConversation(props: Omit<Parameters<typeof AskConversationContent>[0], 'docked' | 'dockControls' | 'onAdditionalWidthChange'>) {
  const [additionalWidth, setAdditionalWidth] = useState(0);
  return <SessionViewPlacement id={`ask:${props.storageScope}`} title="Ask" visible additionalWidth={isAskAttached(props.entry) ? additionalWidth : 0}>
    {({ docked, controls }) => <AskConversationContent {...props} docked={docked} dockControls={controls} onAdditionalWidthChange={setAdditionalWidth} />}
  </SessionViewPlacement>;
}

function AskConversationContent({ docked, dockControls, onAdditionalWidthChange, entry, replica, transport, draftBinding, onClose, onToggleEnabled, onClean, onRetry, onSendInput, onDiscardInput, triggerRef, storageScope, navigation, ...storageBindings }: AskStorageBindings & {
  docked: boolean; dockControls: ReactNode;
  onAdditionalWidthChange(width: number): void;
  navigation?: SessionViewNavigationFactory;
  storageScope: string; triggerRef: RefObject<HTMLButtonElement>; entry: AskEntry; replica?: AgentReplica; transport: RemoteAgentTransport;
  draftBinding: DraftBinding; onClose(): void; onToggleEnabled(): void; onClean(): void; onRetry(): void; onSendInput(id: string, send: AskInputSender): void; onDiscardInput(id: string): void;
}) {
  const shared = useWindowLayout();
  const titleInteraction = useContext(SessionTitleInteractionContext);
  const presentedViewId = useContext(WindowPresentationContext) ?? shared?.window.selectedViewId;
  const selected = !isAskAttached(entry) && !!storageBindings.viewId && storageBindings.viewId === presentedViewId;
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closingWithFocus = useRef(false);
  const busy = !!entry.busy || !!entry.restoring;
  const close = useCallback(() => {
    closingWithFocus.current = !!panel.current?.contains(document.activeElement);
    onClose();
  }, [onClose]);
  useAskPosition(panel, triggerRef, storageScope, { docked, besideAnchor: true, edgeControls: '.lab-tracking-floating .lab-session-popover-trigger' });
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [close]);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = panel.current;
    if (!element?.contains(previous)) returnFocus.current = previous instanceof HTMLElement && previous !== document.body ? previous : triggerRef.current;
    if (!entry.restoring && !entry.restoreOnly) element?.focus({ preventScroll: true });
    return () => {
      if (!closingWithFocus.current && !element?.contains(document.activeElement)) return;
      const target = returnFocus.current;
      // Restore focus after the conversation releases its controls.
      queueMicrotask(() => {
        if (document.activeElement === document.body && target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [triggerRef]);
  const tools = <div className="lab-ask-controls"><SessionHeadingActions sessionKey={storageScope} alwaysCollapsed>{dockControls}
    <button type="button" aria-label="Clean Ask" title="Start a fresh Ask conversation" disabled={busy || !!entry.inputs?.length} onClick={onClean}>Clean</button>
    </SessionHeadingActions>
    <button type="button" aria-label="Minimize Ask" title="Minimize Ask" onClick={close}>×</button>
  </div>;
  const notice = <>{entry.inputs?.length ? <div className="lab-ask-waiting" role="status">Waiting to send: {entry.inputs.map(input => <div key={input.id}>
      {input.text}<button type="button" aria-label="Discard saved question" onClick={() => onDiscardInput(input.id)}>Discard</button>
    </div>)}</div> : null}
    {entry.error ? <div className="lab-ask-error" role="alert">{entry.error}<button type="button" disabled={busy} onClick={onRetry}>Retry</button></div> : null}</>;
  return <div className="lab-ask-viewport"><section className="lab-ask-window lab-session-pane-selection" role="dialog" aria-label="Ask" aria-modal="false" tabIndex={-1} ref={panel}
    data-selected={selected || undefined} aria-current={selected ? 'true' : undefined}>
    {isAskAttached(entry) ? <AskChat key={askParticipantKey(entry.record!)} record={entry.record!} executionTarget={entry.executionTarget} inputs={entry.error ? undefined : entry.inputs} onSendInput={onSendInput} replica={replica} transport={transport}
      storageScope={storageScope} navigation={navigation} onToggleEnabled={onToggleEnabled} busy={busy} draftBinding={draftBinding} tools={tools} notice={notice} onAdditionalWidthChange={onAdditionalWidthChange} {...storageBindings} /> : <>
      <header className="lab-ask-heading"><strong {...titleInteraction}>Ask</strong>{tools}</header>
      {notice}
      {busy || !entry.error ? <div className="lab-ask-opening" role="status">{busy ? 'Opening Ask…' : 'Ask about this conversation.'}</div> : null}
      <AskDraft binding={draftBinding} />
    </>}
    <AskResize />
  </section></div>;
}

function AskChat({ storageScope, record, executionTarget, inputs, onSendInput, replica, transport, draftBinding, tools, notice, busy, onToggleEnabled, navigation, onAdditionalWidthChange, ...storageBindings }: AskStorageBindings & {
  storageScope: string; navigation?: SessionViewNavigationFactory;
  onAdditionalWidthChange(width: number): void;
  onToggleEnabled(): void; record: SessionFork; executionTarget?: import('../directory-client.js').OpenedSession; inputs?: AskInput[]; onSendInput(id: string, send: AskInputSender): void; replica?: AgentReplica; transport: RemoteAgentTransport;
  draftBinding: DraftBinding; tools: ReactNode; notice: ReactNode; busy?: boolean;
}) {
  const session = executionTarget ?? record.target!;
  const sendMessage = useRef<ReturnType<typeof useConversationSession>['actions']['sendMessage']>(undefined);
  const onSessionReady = useCallback((conversation: ReturnType<typeof useConversationSession> | undefined) => {
    sendMessage.current = conversation?.actions.sendMessage;
    if (conversation?.sendQueuedInput && !busy && inputs?.[0]) onSendInput(inputs[0].id, conversation.sendQueuedInput);
  }, [inputs, onSendInput, busy]);
  return <SessionFamily storageScope={storageScope} baseUrl={storageBindings.baseUrl ?? storageScope}
    replica={replica} onSessionReady={onSessionReady} attachedSession={session} target={{ hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId, title: 'Ask' }} hostLabel={session.hostId ?? 'local'}
    compact={storageBindings.compact ?? false} active offline={false} nativePrefixOnly transport={transport}
    draftStore={draftBinding.store} draftBinding={draftBinding} navigation={navigation} controls={tools} onAdditionalWidthChange={onAdditionalWidthChange} {...storageBindings}
    sessionPresentation={context => context.isRoot ? { headingStart: <SessionLink session={context.session} />, sessionManager: tools, composerNotice: notice } : {}}
    consoleCommands={[askCommand]} onExecuteConsoleCommand={async (_id, args) => {
      if (args.trim()) {
        if (!sendMessage.current) throw new Error('Wait for Ask to finish synchronizing.');
        await sendMessage.current(args.trim());
      } else onToggleEnabled();
      return {};
    }} />;
}

function AskDraft({ binding }: { binding: DraftBinding }) {
  const draft = useBoundDraft(binding);
  return <textarea className="lab-ask-draft" aria-label="Ask draft" rows={2} placeholder="Ask anything…" value={draft.text} onChange={event => draft.set(event.target.value)} />;
}
