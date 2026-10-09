import { TrackViewCommand, TrackViewScope } from '../hooks/useSessionAttention.js';
import { useContext, type ComponentProps } from 'react';
import { SessionWorkbench } from './SessionWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { WorkspaceVscodeLink } from './HostVscodeTunnel.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
import { useSessionDisplayPreferences } from '../hooks/useSessionDisplayPreferences.js';
export type { SessionViewActions as LabWorkbenchActions } from '@orchardworks/agent-remote-web/react';

/** Product policy is supplied around the same session renderer used by ARDB. */
export function LabWorkbench({ draftBinding, defaultDisplayMode, ...props }: ComponentProps<typeof SessionWorkbench> & { draftBinding?: DraftBinding }) {
  const trackCommand = useContext(TrackViewScope);
  const positions = useContext(RecoveryScope);
  const draft = useBoundDraft(draftBinding);
  const [displayPreferences, onDisplayPreferencesChange] = useSessionDisplayPreferences(positions?.scope,
    props.draftSessionKey ?? props.state?.agent?.runtimeInfo.sessionId ?? props.attachingAgentId, defaultDisplayMode);
  return <SessionWorkbench {...props}
    consoleCommands={trackCommand ? [TrackViewCommand, ...(props.consoleCommands ?? [])] : props.consoleCommands}
    onExecuteConsoleCommand={trackCommand ? (id, args) => id === TrackViewCommand.id ? trackCommand(args)
      : props.onExecuteConsoleCommand ? props.onExecuteConsoleCommand(id, args) : Promise.reject(new Error('Unknown console command.')) : props.onExecuteConsoleCommand}
    displayPreferences={displayPreferences} onDisplayPreferencesChange={onDisplayPreferencesChange}
    readingPositions={positions} draftScope={positions?.scope}
    messageDraft={draftBinding ? draft.text : props.messageDraft} onMessageDraftChange={draftBinding ? draft.set : props.onMessageDraftChange}
    workspaceLink={<WorkspaceVscodeLink workspace={props.state?.agent?.cwd} />}
    isAuthenticationError={needsReauthentication} authenticationNotice={<ReauthenticationNotice />}
    renderSessionSettingError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="permissions" /> : undefined} />;
}
