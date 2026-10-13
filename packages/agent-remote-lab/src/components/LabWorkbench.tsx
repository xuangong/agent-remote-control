import { TeamViewCommand, TeamViewScope } from '../hooks/useTeamVisibility.js';
import { TrackViewCommand, TrackViewScope } from '../hooks/useSessionAttention.js';
import { TpmViewCommand, TpmViewScope } from '../hooks/useTpmVisibility.js';
import { useContext, type ComponentProps } from 'react';
import { SessionWorkbench } from './SessionWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { WorkspaceVscodeLink } from './HostVscodeTunnel.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
import { useSessionDisplayPreferences, type DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { DraftRecoveryNotice } from './DraftRecoveryNotice.js';
export type { SessionViewActions as LabWorkbenchActions } from '@orchardworks/agent-remote-web/react';

/** Product policy is supplied around the same session renderer used by ARDB. */
export function LabWorkbench({ draftBinding, displayBinding, defaultDisplayMode, ...props }: ComponentProps<typeof SessionWorkbench> & { draftBinding?: DraftBinding; displayBinding?: DisplayPreferenceBinding }) {
  const trackCommand = useContext(TrackViewScope);
  const tpmCommand = useContext(TpmViewScope);
  const teamCommand = useContext(TeamViewScope);
  const positions = useContext(RecoveryScope);
  const draft = useBoundDraft(draftBinding);
  const [displayPreferences, onDisplayPreferencesChange] = useSessionDisplayPreferences(displayBinding?.scope ?? positions?.scope,
    displayBinding?.key ?? props.draftSessionKey ?? props.state?.agent?.runtimeInfo.sessionId ?? props.attachingAgentId, defaultDisplayMode);
  return <SessionWorkbench {...props}
    consoleCommands={trackCommand || tpmCommand || teamCommand ? [...(trackCommand ? [TrackViewCommand] : []), ...(tpmCommand ? [TpmViewCommand] : []), ...(teamCommand ? [TeamViewCommand] : []), ...(props.consoleCommands ?? [])] : props.consoleCommands}
    onExecuteConsoleCommand={trackCommand || tpmCommand || teamCommand ? (id, args) => id === TrackViewCommand.id && trackCommand ? trackCommand(args)
      : id === TpmViewCommand.id && tpmCommand ? tpmCommand(args)
      : id === TeamViewCommand.id && teamCommand ? teamCommand(args)
      : props.onExecuteConsoleCommand ? props.onExecuteConsoleCommand(id, args) : Promise.reject(new Error('Unknown console command.')) : props.onExecuteConsoleCommand}
    displayPreferences={displayPreferences} onDisplayPreferencesChange={onDisplayPreferencesChange}
    readingPositions={positions} draftScope={positions?.scope}
    composerNotice={<>{props.composerNotice}{draftBinding ? <DraftRecoveryNotice binding={draftBinding} /> : null}</>}
    messageDraft={draftBinding ? draft.text : props.messageDraft} onMessageDraftChange={draftBinding ? draft.set : props.onMessageDraftChange}
    workspaceLink={<WorkspaceVscodeLink workspace={props.state?.agent?.cwd} />}
    isAuthenticationError={needsReauthentication} authenticationNotice={<ReauthenticationNotice />}
    renderSessionSettingError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="permissions" /> : undefined} />;
}
