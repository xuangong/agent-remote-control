import { useContext, type ComponentProps } from 'react';
import { SessionWorkbench } from './SessionWorkbench.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { WorkspaceVscodeLink } from './HostVscodeTunnel.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';
export type { SessionViewActions as LabWorkbenchActions } from '@orchardworks/agent-remote-web/react';

/** Product policy is supplied around the same session renderer used by ARDB. */
export function LabWorkbench({ draftBinding, ...props }: ComponentProps<typeof SessionWorkbench> & { draftBinding?: DraftBinding }) {
  const positions = useContext(RecoveryScope);
  const draft = useBoundDraft(draftBinding);
  return <SessionWorkbench {...props}
    readingPositions={positions} draftScope={positions?.scope}
    messageDraft={draftBinding ? draft.text : props.messageDraft} onMessageDraftChange={draftBinding ? draft.set : props.onMessageDraftChange}
    workspaceLink={<WorkspaceVscodeLink workspace={props.state?.agent?.cwd} />}
    isAuthenticationError={needsReauthentication} authenticationNotice={<ReauthenticationNotice />}
    renderSessionSettingError={error => needsReauthentication(error) ? <ReauthenticationNotice purpose="permissions" /> : undefined} />;
}
