import { TeamViewCommand, TeamViewScope } from '../hooks/useTeamVisibility.js';
import { TrackViewCommand, TrackViewScope } from '../hooks/useSessionAttention.js';
import { TpmViewCommand, TpmViewScope } from '../hooks/useTpmVisibility.js';
import { AskViewCommand, AskViewScope } from '../hooks/useAskVisibility.js';
import { useContext, type ComponentProps } from 'react';
import { SessionWorkbench } from './SessionWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { WorkspaceVscodeLink } from './HostVscodeTunnel.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
import { useSessionDisplayPreferences, type DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { DraftRecoveryNotice } from './DraftRecoveryNotice.js';
import { usePromptEditOperation } from '../hooks/usePromptEditOperation.js';
import { SessionViewOperationsContext, type SessionOperationBinding } from '../session-view-operations.js';
export type { SessionViewActions as LabWorkbenchActions } from '@orchardworks/agent-remote-web/react';

/** Product policy is supplied around the same session renderer used by ARDB. */
export function LabWorkbench({ draftBinding, displayBinding, defaultDisplayMode, operationBinding, ...props }: ComponentProps<typeof SessionWorkbench> & { draftBinding?: DraftBinding; displayBinding?: DisplayPreferenceBinding; operationBinding?: SessionOperationBinding }) {
  const trackCommand = useContext(TrackViewScope);
  const tpmCommand = useContext(TpmViewScope);
  const teamCommand = useContext(TeamViewScope);
  const askVisibility = useContext(AskViewScope);
  const sourceAskCommand = props.onExecuteConsoleCommand && props.consoleCommands?.find(command => command.id === AskViewCommand.id);
  const positions = useContext(RecoveryScope);
  const operations = useContext(SessionViewOperationsContext);
  const draftScope = positions?.scope ?? operations?.storageScope;
  const imageBinding = props.imageDraftBinding ?? (draftScope && props.draftSessionKey ? { scope: draftScope, key: JSON.stringify([draftScope, props.draftSessionKey]) } : undefined);
  const promptEdit = usePromptEditOperation(operationBinding, draftBinding, imageBinding, displayBinding?.key ?? draftBinding?.key, props.imageRecipient);
  const draft = useBoundDraft(draftBinding);
  const [displayPreferences, onDisplayPreferencesChange] = useSessionDisplayPreferences(displayBinding?.scope ?? positions?.scope,
    displayBinding?.key ?? props.draftSessionKey ?? props.state?.agent?.runtimeInfo.sessionId ?? props.attachingAgentId, defaultDisplayMode);
  return <SessionWorkbench {...props}
    readOnly={props.readOnly || promptEdit.recoveringDraft}
    actions={{ ...props.actions, ...(promptEdit.editPrompt ? { editPrompt: promptEdit.editPrompt } : {}) }}
    imageDraftBinding={imageBinding}
    consoleCommands={trackCommand || tpmCommand || teamCommand || askVisibility ? [...(trackCommand ? [TrackViewCommand] : []), ...(tpmCommand ? [TpmViewCommand] : []), ...(teamCommand ? [TeamViewCommand] : []), ...(askVisibility ? [sourceAskCommand || AskViewCommand] : []), ...(props.consoleCommands ?? []).filter(command => !askVisibility || command.id !== AskViewCommand.id)] : props.consoleCommands}
    onExecuteConsoleCommand={trackCommand || tpmCommand || teamCommand || askVisibility ? (id, args) => id === TrackViewCommand.id && trackCommand ? trackCommand(args)
      : id === TpmViewCommand.id && tpmCommand ? tpmCommand(args)
      : id === TeamViewCommand.id && teamCommand ? teamCommand(args)
      : id === AskViewCommand.id && askVisibility && (!sourceAskCommand || ['', 'on', 'off', 'enable', 'disable'].includes(args.trim().toLowerCase())) ? askVisibility(args)
      : props.onExecuteConsoleCommand ? props.onExecuteConsoleCommand(id, args) : Promise.reject(new Error('Unknown console command.')) : props.onExecuteConsoleCommand}
    displayPreferences={displayPreferences} onDisplayPreferencesChange={onDisplayPreferencesChange}
    readingPositions={positions} draftScope={draftScope}
    composerNotice={<>{props.composerNotice}{promptEdit.notice}{draftBinding ? <DraftRecoveryNotice binding={draftBinding} /> : null}</>}
    messageDraft={draftBinding ? draft.text : props.messageDraft} onMessageDraftChange={draftBinding ? draft.set : props.onMessageDraftChange}
    workspaceLink={<WorkspaceVscodeLink workspace={props.state?.agent?.cwd} />}
    isAuthenticationError={needsReauthentication} authenticationNotice={<ReauthenticationNotice />}
    renderSessionSettingError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="permissions" /> : undefined} />;
}
