// A conversation's composer region: its status line, the context above the input (host notice, references, notices), the
// collapse toggle and the composer itself, which the region keeps collapsed or open.
import { useId, useRef, useState, type ComponentProps } from 'react';
import type { AgentReplicaState, RemoteSessionState, RemoteSessionStatus } from '@orchardworks/agent-client';
import type { AgentCommand } from '@orchardworks/agent-remote-protocol';
import { AgentComposer as DraftComposer, useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionControlNotice } from './SessionControlNotice.js';
import { PlanningControl } from './PlanningControl.js';
import { useToastAnchor } from '../kernel/Toast.js';
import type { LabWorkbenchActions, SessionWorkbenchProps } from './session-workbench-props.js';

type Passed = Pick<SessionWorkbenchProps, 'composerStatus' | 'composerContext' | 'composerNotice' | 'authenticationNotice' | 'nativeTakeover' | 'host' | 'opening' | 'openFailed'
  | 'onPendingInputChange' | 'pendingFirstInputContext' | 'consoleCommands' | 'onExecuteConsoleCommand' | 'draftSessionKey' | 'draftScope' | 'imageDraftBinding' | 'imageRecipient'
  | 'messageDraft' | 'onMessageDraftChange' | 'sendLater' | 'renderSessionSettingError' | 'renderCommandError' | 'handoff'>;

export function ConversationComposer({ composerStatus, composerContext, composerNotice, authenticationNotice, reauthenticate, hostNotice, nativeTakeover, host, opening, openFailed,
  onPendingInputChange, pendingFirstInputContext, consoleCommands, onExecuteConsoleCommand, draftSessionKey, draftScope, imageDraftBinding, imageRecipient, messageDraft, onMessageDraftChange,
  sendLater, renderSessionSettingError, renderCommandError, handoff, state, session, sessionStatus, visible, draftOnly, hasTarget, readOnly, controlReadOnly, recordingReadOnly,
  mutationBlocked, chromeless, recipient, actions, feedbackActions, takeControl, onInspectCommand, quote, mentions }: Passed & {
  state?: AgentReplicaState; session: RemoteSessionState; sessionStatus: RemoteSessionStatus; visible: boolean; draftOnly: boolean;
  /** The view has a session to show, resolved or not. */
  hasTarget: boolean;
  readOnly: boolean; controlReadOnly: boolean; recordingReadOnly: boolean; mutationBlocked: boolean;
  /** Show the authentication notice: an action failed for lack of a valid sign-in. */
  reauthenticate: boolean;
  /** An offline Host or a usage limit, said once in the composer's context. */
  hostNotice?: string;
  /** The assistant's top bar or a tile's header shows the settings, and the input names who it writes to. */
  chromeless: boolean; recipient?: string;
  /** The actions the view offers, and the same actions with their failures reported (sending goes through these). */
  actions: LabWorkbenchActions; feedbackActions: LabWorkbenchActions; takeControl: LabWorkbenchActions['takeControl'];
  onInspectCommand(command: AgentCommand): void;
  /** A message quoted from the timeline, which the composer puts at the end of its draft. */
  quote?: { id: number; text: string };
  /** The bots `@` offers, and the ask. */
  mentions?: ComponentProps<typeof DraftComposer>['mentions'];
}) {
  const t = useTranslate();
  const [composerHidden, setComposerHidden] = useState(false);
  const composerId = useId();
  const toastAnchor = useToastAnchor(visible && !!state?.agent && !composerHidden);
  const composerTouchBoundary = useRef<HTMLDivElement>(null);
  const toastToggleAnchor = useToastAnchor<HTMLButtonElement>(visible && !!state?.agent);
  return <div className="lab-composer-region">
    {composerStatus}
    <div ref={toastAnchor} className="lab-composer-dock" hidden={!state?.agent && !nativeTakeover && !draftOnly && !hasTarget} data-collapsed={composerHidden || undefined}>
      <div className="lab-composer-context" hidden={composerHidden}>
        {hostNotice ? <p className="lab-composer-host-notice" role="status">{hostNotice}</p> : null}
        {composerContext}
        {composerNotice}
        {reauthenticate ? authenticationNotice : null}
      </div>
      <div ref={composerTouchBoundary} className="lab-composer-input-shell">
        <button ref={toastToggleAnchor} type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
          aria-label={composerHidden ? t('composer.view.showInput') : t('composer.view.hideInput')} title={composerHidden ? t('composer.view.showInput') : t('composer.view.hideInput')}
          onClick={() => setComposerHidden(hidden => !hidden)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
          </svg>
        </button>
        <div id={composerId} className="lab-composer-body" hidden={composerHidden && !controlReadOnly}>
          <DraftComposer
            keyboardDismissBoundaryRef={composerTouchBoundary}
            settings={chromeless ? 'none' : 'inline'}
            sessionState={session}
            host={host}
            draftOnly={draftOnly}
            opening={opening}
            openFailed={openFailed}
            mutationBlocked={mutationBlocked}
            onPendingInputChange={onPendingInputChange}
            pendingFirstInputContext={pendingFirstInputContext}
            readOnly={readOnly}
            readOnlyCollapsed={composerHidden}
            readOnlyLabel={controlReadOnly && !recordingReadOnly ? t('composer.view.readOnly') : undefined}
            recipient={chromeless ? recipient : undefined}
            readOnlyNotice={nativeTakeover ?? (!draftOnly && !recordingReadOnly && controlReadOnly && state?.sessionControl ? <SessionControlNotice handoff={handoff ?? session.handoff} control={state.sessionControl} connected={sessionStatus === 'ready'} onTakeControl={takeControl} /> : undefined)}
            consoleCommands={!readOnly && !mutationBlocked && sessionStatus === 'ready' ? consoleCommands : []}
            onExecuteConsoleCommand={!readOnly && !mutationBlocked && sessionStatus === 'ready' ? onExecuteConsoleCommand : undefined}
            sessionControls={state?.agent && !draftOnly ? <PlanningControl sessionState={session} key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
            state={state}
            sessionKey={draftSessionKey ?? state?.agent?.id}
            draftScope={draftScope}
            imageDraftBinding={imageDraftBinding} imageRecipient={imageRecipient}
            visible={visible}
            activityVisible={visible && !composerHidden}
            onSendMessageContent={readOnly || mutationBlocked ? undefined : feedbackActions.sendMessageContent}
            onUploadResource={visible ? actions.uploadResource : undefined}
            onUploadImage={visible ? actions.uploadImage : undefined}
            draft={messageDraft}
            onDraftChange={onMessageDraftChange}
            onSendMessage={readOnly || mutationBlocked ? undefined : feedbackActions.sendMessage}
            sendLater={readOnly ? undefined : sendLater}
            onCancel={actions.cancel}
            onSetSessionSetting={actions.setSessionSetting}
            renderSessionSettingError={renderSessionSettingError}
            renderCommandError={renderCommandError}
            onListCommands={actions.listCommands}
            onExecuteCommand={actions.executeCommand}
            onRequestResource={actions.requestResource}
            onResolveResource={actions.resolveResource}
            onInspectCommand={onInspectCommand}
            quote={quote}
            mentions={mentions}
          />
        </div>
      </div>
    </div>
  </div>;
}
