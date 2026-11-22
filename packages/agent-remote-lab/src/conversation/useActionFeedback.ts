// How a conversation reports the failure of an action it ran: a toast in business words, or the reauthentication notice.
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorWords, isUncertainSend, type MessageKey } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useFeedbackToast } from '../kernel/Toast.js';
import type { LabWorkbenchActions } from './session-workbench-props.js';

/** Stream capacity explains what frees a slot, and a paused session says how it resumes; other interruptions only reconnect. */
export function useActionFeedback(actions: LabWorkbenchActions, sessionId: string | undefined, isAuthenticationError: (error: unknown) => boolean, presentedInline: readonly MessageKey[]): { actions: LabWorkbenchActions; reauthenticate: boolean } {
  const t = useTranslate();
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [failure, setFailure] = useState<{ title: MessageKey; message: string; reauthenticate: boolean }>();
  useFeedbackToast(t(failure?.title ?? 'composer.action.session'), failure?.reauthenticate ? undefined : failure?.message);
  useEffect(() => setFailure(undefined), [sessionId]);
  /** `recorded` tells the failures the conversation shows itself, which need no toast. */
  function report<Args extends unknown[], Result>(title: MessageKey, action: ((...args: Args) => Result) | undefined, recorded: (error: unknown) => boolean = () => false) {
    return action ? async (...args: Args): Promise<Awaited<Result>> => {
      setFailure(undefined);
      try { return await action(...args); }
      catch (error) {
        if (activeSession.current === sessionId && !recorded(error)) setFailure({ title, message: errorWords(error, t, 'composer.action.unconfirmed'), reauthenticate: isAuthenticationError(error) });
        throw error;
      }
    } : undefined;
  }
  // An uncertain send stays on its outgoing message, which says in plain words what to check and what Retry does next.
  const reportedActions = useMemo(() => ({ ...actions,
    sendMessage: report('composer.action.send', actions.sendMessage, isUncertainSend), sendMessageContent: report('composer.action.send', actions.sendMessageContent, isUncertainSend),
    retryMessage: report('composer.action.retry', actions.retryMessage, isUncertainSend),
    steer: report('composer.action.steer', actions.steer), cancel: report('composer.action.stop', actions.cancel),
    respondToInteraction: report('composer.action.respond', actions.respondToInteraction),
    setPlanning: report('composer.action.mode', actions.setPlanning), setSessionSetting: report('composer.action.setting', actions.setSessionSetting),
    listCommands: report('composer.action.commands', actions.listCommands), executeCommand: report('composer.action.command', actions.executeCommand),
    loadOlder: report('composer.action.history', actions.loadOlder),
    editPrompt: report('composer.action.edit', actions.editPrompt),
  }), [actions, sessionId, t]);
  return { actions: reportedActions, reauthenticate: failure?.reauthenticate === true && !presentedInline.includes(failure.title) };
}
