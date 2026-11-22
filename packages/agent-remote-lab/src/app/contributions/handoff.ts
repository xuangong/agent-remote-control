// What a handoff says about a session view: the /handoff command, its progress line, and the wait while a handoff is under way.
import type { Translate } from '@orchardworks/agent-client';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { handoffCommand, handoffProvider } from '../../handoff-command.js';
import { SessionDirectoryClient } from '../../kernel/directory-client.js';
import { labSessionSuccessionDirectory } from '../../kernel/session-succession-directory.js';
import { viewKey } from '../helpers.js';
import type { PresentationScope } from './scope.js';

export type HandoffContributionInputs = Pick<PresentationScope, 'baseUrl' | 'botHandoff' | 'directory' | 'setSuccessionDialog' | 'sourceStateFor' | 'successionDialog' | 'successionGated' | 'successionProgress' | 'userScoped'> & { t: Translate };

export const handoffContribution = (inputs: HandoffContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { baseUrl, botHandoff, directory, setSuccessionDialog, sourceStateFor, successionDialog, successionGated, successionProgress, userScoped, t } = inputs;
  const { context, botPresentation, source, host, available } = view;
  const gated = successionGated && successionDialog?.scope === baseUrl && viewKey(successionDialog.source) === source.viewId;
  const handoffAvailable = available && (!botPresentation || context.state?.agent?.status === 'idle') && !successionDialog && userScoped && !!directory && !source.parentNativeSessionId
    && !context.sessionState.readOnly && !context.operationBinding.historical && host?.access !== 'shared' && host?.online === true;
  return {
    blocksMutation: gated,
    consoleCommands: handoffAvailable ? [handoffCommand] : [],
    onConsoleCommand: (id, args) => {
      if (id !== handoffCommand.id) return undefined;
      if (botPresentation && sourceStateFor(source)?.agent?.status !== 'idle') throw new Error(t('sessions.presentation.waitIdle'));
      if (!handoffAvailable) throw new Error(t('sessions.presentation.handoffNeeds'));
      setSuccessionDialog({ scope: baseUrl, source, visible: true, initialProvider: handoffProvider(args), directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)) });
      return Promise.resolve({});
    },
    composerStatus: !botHandoff && (gated || successionDialog && viewKey(successionDialog.source) === source.viewId) ? successionProgress : null,
  };
};
