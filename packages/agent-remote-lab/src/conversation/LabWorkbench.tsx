import { TrackViewCommand, TrackViewScope } from '../kernel/useSessionAttention.js';
import { AskViewCommand, AskViewScope } from '../kernel/useAskVisibility.js';
import { useContext, useMemo, type ComponentProps } from 'react';
import { useTaskDirectory, useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionWorkbench } from './ConversationSurface.js';
import { RecoveryScope } from '../kernel/conversation-recovery.js';
import { useBoundDraft, type DraftBinding } from '../kernel/draft-store.js';
import { WorkspaceVscodeLink } from './WorkspaceVscodeLink.js';
import { SessionWorkspaceContext } from '../kernel/SessionLink.js';
import { needsReauthentication } from '../kernel/security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
import type { ViewBinding } from '../kernel/view-binding.js';
import { DraftRecoveryNotice } from './DraftRecoveryNotice.js';
import { usePromptEditOperation } from './usePromptEditOperation.js';
import { SessionViewOperationsContext, type SessionOperationBinding } from './session-view-operations.js';
import { SessionDescriptionsContext } from '../kernel/session-description-context.js';
import { describeSession } from '../kernel/session-description.js';
import type { SessionEntry } from '../kernel/session-tree.js';
import type { SessionExcerpt } from '@orchardworks/agent-remote-protocol';
export type { SessionViewActions as LabWorkbenchActions } from '@orchardworks/agent-client-web/react';

/** Product policy is supplied around the same session renderer used by ARDB. */
export function LabWorkbench({ draftBinding, displayBinding, operationBinding, sessionIdentity, hostLabel, showAttributions = true, receiveQuotes, ...props }: ComponentProps<typeof SessionWorkbench> & { draftBinding?: DraftBinding; displayBinding?: ViewBinding; operationBinding?: SessionOperationBinding; sessionIdentity?: SessionEntry; hostLabel?: string; showAttributions?: boolean; receiveQuotes?(excerpts: readonly SessionExcerpt[]): void }) {
  const t = useTranslate();
  const descriptions = useContext(SessionDescriptionsContext);
  const source = sessionIdentity ?? operationBinding?.source;
  const relationships = showAttributions ? props.sessionDescription ?? (source ? descriptions?.describe(source) ?? describeSession({ session: source }) : undefined) : undefined;
  const trackCommand = useContext(TrackViewScope);
  const askVisibility = useContext(AskViewScope);
  const sourceAskCommand = props.onExecuteConsoleCommand && props.consoleCommands?.find(command => command.id === AskViewCommand.id);
  const positions = useContext(RecoveryScope);
  const operations = useContext(SessionViewOperationsContext);
  const draftScope = positions?.scope ?? operations?.storageScope;
  const imageBinding = props.imageDraftBinding ?? (draftScope && props.draftSessionKey ? { scope: draftScope, key: JSON.stringify([draftScope, props.draftSessionKey]) } : undefined);
  const promptEdit = usePromptEditOperation(operationBinding, draftBinding, imageBinding, displayBinding?.key ?? draftBinding?.key, props.imageRecipient, receiveQuotes);
  const draft = useBoundDraft(draftBinding);
  const agent = props.state?.agent;
  const reportedSession = agent?.runtimeInfo.sessionId, cwd = agent?.cwd, providerId = agent?.providerId;
  const identity = source ?? relationships?.identity;
  // `@Name text` asks that bot from this conversation; it needs the conversation's Host to name it to the Relay.
  const directory = useTaskDirectory();
  const mentions = useMemo(() => directory?.bots && directory.ask && identity?.hostId
    ? { bots: directory.bots(), ask: (bot: { botId: string; name: string }, text: string) => directory.ask!({ hostId: identity.hostId!, providerId: identity.providerId, nativeSessionId: identity.nativeSessionId,
      title: (props.conversationTitle || props.assistant?.name || identity.nativeSessionId).slice(0, 256) }, bot, text) } : undefined,
    [directory, identity?.hostId, identity?.providerId, identity?.nativeSessionId, props.conversationTitle, props.assistant?.name]);
  const resolvedHostLabel = identity && descriptions?.hostName?.(identity.hostId ?? 'local') || hostLabel;
  const matchingAgent = identity && agent?.providerId === identity.providerId && reportedSession === identity.nativeSessionId ? agent : undefined;
  const sessionDescription = showAttributions && identity ? {
    identity,
    attributions: [
      { id: 'identity:host', kind: 'identity', label: t('sessions.workbench.host'), value: resolvedHostLabel ?? identity.hostId ?? 'local',
        ...(resolvedHostLabel && identity.hostId && resolvedHostLabel !== identity.hostId ? { detail: identity.hostId } : {}) },
      { id: 'identity:provider', kind: 'identity', label: t('sessions.workbench.provider'), value: identity.providerId },
      { id: 'identity:cwd', kind: 'identity', label: t('sessions.workbench.cwd'), value: matchingAgent?.cwd || t('sessions.workbench.noHistoryCwd') },
      { id: 'identity:session', kind: 'identity', label: t('sessions.workbench.sessionId'), value: identity.nativeSessionId },
      ...(relationships?.attributions ?? []),
    ],
  } : relationships;
  const workspace = useMemo(() => providerId && reportedSession && cwd ? { providerId, nativeSessionId: reportedSession, cwd } : undefined, [providerId, reportedSession, cwd]);
  return <SessionWorkspaceContext.Provider value={workspace}><SessionWorkbench {...props} mentions={mentions}
    nativeSession={identity ? `${identity.providerId}/${identity.nativeSessionId}` : undefined}
    sessionDescription={sessionDescription} onNavigateAttribution={props.onNavigateAttribution ?? descriptions?.navigate}
    readOnly={props.readOnly || promptEdit.recoveringDraft}
    actions={{ ...props.actions, ...(promptEdit.editPrompt ? { editPrompt: promptEdit.editPrompt } : {}) }}
    imageDraftBinding={imageBinding}
    consoleCommands={trackCommand || askVisibility ? [...(trackCommand ? [TrackViewCommand] : []), ...(askVisibility ? [sourceAskCommand || AskViewCommand] : []), ...(props.consoleCommands ?? []).filter(command => !askVisibility || command.id !== AskViewCommand.id)] : props.consoleCommands}
    onExecuteConsoleCommand={trackCommand || askVisibility ? (id, args) => id === TrackViewCommand.id && trackCommand ? trackCommand(args)
      : id === AskViewCommand.id && askVisibility && (!sourceAskCommand || ['', 'on', 'off', 'enable', 'disable'].includes(args.trim().toLowerCase())) ? askVisibility(args)
      : props.onExecuteConsoleCommand ? props.onExecuteConsoleCommand(id, args) : Promise.reject(new Error(t('sessions.workbench.unknownCommand'))) : props.onExecuteConsoleCommand}
    readingPositions={positions} draftScope={draftScope}
    composerNotice={<>{props.composerNotice}{promptEdit.notice}{draftBinding ? <DraftRecoveryNotice binding={draftBinding} /> : null}</>}
    messageDraft={draftBinding ? draft.text : props.messageDraft} onMessageDraftChange={draftBinding ? draft.set : props.onMessageDraftChange}
    workspaceLink={<WorkspaceVscodeLink workspace={props.state?.agent?.cwd} />}
    isAuthenticationError={needsReauthentication} authenticationNotice={<ReauthenticationNotice />}
    renderSessionSettingError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="permissions" /> : undefined}
    renderCommandError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="command" /> : undefined} /></SessionWorkspaceContext.Provider>;
}
