// What forks and Sides say about a session view: their commands, their first input, and their entries in the composer.
import type { ComponentProps } from 'react';
import type { RemoteAgentTransport, Translate } from '@orchardworks/agent-client';
import type { AgentCommandResult, WindowView } from '@orchardworks/agent-remote-protocol';
import { forkActions, forkCommands } from '../../conversation/fork-actions.js';
import type { LabWorkbenchActions } from '../../conversation/LabWorkbench.js';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { forkDisplayState, type ForkStore, type SessionFork } from '../../kernel/session-forks.js';
import { sessionKey } from '../../kernel/session-tree.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import type { OpenedSession } from '../../kernel/directory-client.js';
import { ForkEntries } from './ForkReference.js';

export interface ForkContributionInputs {
  forkStore: ForkStore;
  /** The session's own actions, when the page has them; otherwise the conversation's. */
  actions: LabWorkbenchActions | undefined;
  transport: RemoteAgentTransport;
  /** The Window's views as they are now. */
  readWindowViews(): readonly WindowView[] | undefined;
  forkInputStatus: { agentId: string; pending: boolean } | undefined;
  directory: unknown;
  createFork(state: AgentReplicaState, source: OpenedSession, id: string, args: string): Promise<AgentCommandResult>;
  openFork(record: SessionFork): Promise<void>;
  openSideKeys(viewId: string): string[];
  unlinkSide: NonNullable<ComponentProps<typeof ForkEntries>['onUnlink']>;
  reconcile(record: SessionFork): Promise<void>;
  t: Translate;
}

export const forkContribution = (inputs: ForkContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { forkStore, actions, transport, readWindowViews, forkInputStatus, directory, createFork, openFork, openSideKeys, unlinkSide, reconcile, t } = inputs;
  const { context, options, botPresentation, source, fork, sourceForks, available } = view;
  // In a Window, a fork view's input belongs to the fork only while that view still shows it.
  const forkTarget = fork?.target;
  const targetsFork = forkTarget && context.windowViewId ? () => {
    const binding = readWindowViews()?.find(item => item.id === context.windowViewId)?.binding;
    return !!binding && sessionKey({ ...binding, hostId: binding.hostId ?? 'local' }) === sessionKey({ ...forkTarget, hostId: forkTarget.hostId ?? 'local' });
  } : undefined;
  const commandSet = botPresentation ? context.actions : forkActions(actions ?? context.actions, forkStore, fork, transport, targetsFork);
  return {
    props: { state: botPresentation ? context.state : forkDisplayState(context.state, fork) },
    commandSet,
    firstInputPending: !!forkInputStatus?.pending && forkInputStatus.agentId === source.agentId,
    // In Bot mode a Side joins the bot's group beside it (a Side is a bot); a fork or an Ask would open elsewhere.
    consoleCommands: available && directory && context.state?.agent?.capabilities.sendMessage && context.state.agent.capabilities.history
      ? botPresentation ? options.bot ? forkCommands.filter(command => command.id === 'console:side') : [] : forkCommands : [],
    onConsoleCommand: (id, args) => {
      // A Side joins a bot's group; a session listed under Other sessions has no group to join.
      if (botPresentation && (id !== 'console:side' || !options.bot)) throw new Error(t('sessions.presentation.botUnavailable'));
      if (!context.state || !available) throw new Error(t('sessions.sending.waitSync'));
      return createFork(context.state, source, id, args);
    },
    composerNotice: botPresentation ? undefined : <ForkEntries forks={sourceForks} openSides={openSideKeys(source.viewId)} onOpen={record => void openFork({ ...record, navigationSource: source })} onUnlink={unlinkSide} onRecover={record => reconcile(record)} />,
  };
};
