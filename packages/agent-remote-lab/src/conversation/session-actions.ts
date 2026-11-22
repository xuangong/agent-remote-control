// Which of a conversation's actions its view offers, from the view's mode and the session's operations: a pure rule.
import type { RemoteSessionState } from '@orchardworks/agent-client';
import type { LabWorkbenchActions } from './session-workbench-props.js';

/** What decides the offered actions: how the view is shown, and what the session allows now. */
export interface SessionActionFacts {
  /** A composer with no session behind it yet: it offers nothing. */
  draftOnly: boolean;
  /** Read-only by recording, by a native takeover or by the lease. */
  readOnly: boolean;
  /** Sending is held: a Handoff in progress, or a Window not yet confirmed by the service. */
  mutationBlocked: boolean;
  session: Pick<RemoteSessionState, 'synchronized' | 'operations'>;
}

/** The actions a view that may only read keeps: search, history, resources and deleting a local message. */
const readingActions = ['searchTimeline', 'loadSearchMatch', 'loadOlder', 'requestResource', 'resolveResource', 'deleteMessage'] as const;

/**
 * The actions a view offers. A draft-only view offers none; a read-only or held view keeps only its reading actions; an
 * unsynchronized session offers only deleting a local message; a synchronized one offers every action, each operation-bound
 * one only while the session allows that operation (a prompt edit and a retry are sends).
 */
export function sessionActions(facts: SessionActionFacts, actions: LabWorkbenchActions): LabWorkbenchActions {
  if (facts.draftOnly) return {};
  if (facts.readOnly || facts.mutationBlocked) return Object.fromEntries(readingActions.map(name => [name, actions[name]])) as LabWorkbenchActions;
  if (!facts.session.synchronized) return { deleteMessage: actions.deleteMessage };
  const allowed = facts.session.operations;
  return { ...actions,
    retryMessage: allowed.send_message.allowed ? actions.retryMessage : undefined,
    editPrompt: allowed.send_message.allowed ? actions.editPrompt : undefined,
    cancel: allowed.cancel.allowed ? actions.cancel : undefined,
    setPlanning: allowed.set_planning.allowed ? actions.setPlanning : undefined,
    setSessionSetting: allowed.set_session_setting.allowed ? actions.setSessionSetting : undefined,
    executeCommand: allowed.execute_command.allowed ? actions.executeCommand : undefined,
    respondToInteraction: allowed.interaction_response.allowed ? actions.respondToInteraction : undefined,
  };
}
