// What every contribution to a session view reads, what it yields, and how the contributions merge into the view's props.
//
// Contract
// - A feature owns one contribution: `(inputs) => (view: SessionViewContext) => SessionViewContribution`. `inputs` is a typed
//   object the contribution declares and reads from; `view` holds the facts about the one view being presented.
// - A contribution never reads another contribution's output. The props it sets in `props` are its own, and no other
//   contribution sets them.
// - Seven props combine what several features say, and the merge below is the only place their order is stated:
//   actions, consoleCommands, onExecuteConsoleCommand, composerStatus, composerContext, composerNotice, mutationBlocked.
import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react';
import type { AgentCommandResult, WindowView } from '@orchardworks/agent-remote-protocol';
import type { LabWorkbench, LabWorkbenchActions } from './LabWorkbench.js';
import type { FamilySessionPresentationContext } from './SessionFamily.js';
import type { OpenedSession } from '../kernel/directory-client.js';
import type { SessionFork } from '../kernel/session-forks.js';
import type { RemoteHost } from '../kernel/remote-host.js';

export type SessionViewProps = Partial<ComponentProps<typeof LabWorkbench>>;
export type SessionViewCommand = NonNullable<SessionViewProps['consoleCommands']>[number];

/** The props that several contributions combine; the merge sets them. */
export type MergedSessionViewProp = 'actions' | 'consoleCommands' | 'onExecuteConsoleCommand' | 'composerStatus' | 'composerContext' | 'composerNotice' | 'mutationBlocked';

export interface SessionViewOptions { bot?: { groupId: string; viewId: string }; fallback?: boolean }

/** The session a view presents, with the view that holds it and, in Bot mode, the bot it belongs to. */
export type SessionViewSource = OpenedSession & { hostId: string; viewId: string; bot?: { groupId: string; viewId: string }; fallback?: true };

/** A command handler answers a console command it owns, or returns nothing for one that is not its own. */
export type ConsoleCommandHandler = (id: string, args: string) => Promise<AgentCommandResult> | undefined;

/** The facts about one view, derived once per presentation. */
export interface SessionViewContext {
  readonly context: FamilySessionPresentationContext;
  readonly options: SessionViewOptions;
  /** Bot mode's conversation, or a session listed under Other sessions. */
  readonly botPresentation: boolean;
  readonly source: SessionViewSource;
  /** The Window view that shows the session; in Bot mode, the bot's view in its group. */
  readonly view: WindowView | undefined;
  /** A bot's pane in a Window of bots: the same bot as in Bot mode. */
  readonly windowBot: boolean;
  readonly isPrimary: boolean;
  readonly fork: SessionFork | undefined;
  /** The linked Sides and forks that start from this session. */
  readonly sourceForks: readonly SessionFork[];
  readonly host: RemoteHost | undefined;
  /** The conversation is synchronised, online and current: the owner may act on it. */
  readonly available: boolean;
  /** The view id when the view takes part in quoting between the session views of shared Windows. */
  readonly quoteView: string | undefined;
  /** Opens the view's bot in Bot mode, for a bot of a Window. */
  readonly openBot: (() => void) | undefined;
  /** A cached Window not yet confirmed by the service. */
  readonly provisional: boolean;
  /** Throws when the session is no longer the one the page shows. */
  readonly assertCurrent: () => void;
}

/** What one feature says about a view. Every field is optional. */
export interface SessionViewContribution {
  /** Props only this contribution sets. */
  props?: Omit<SessionViewProps, MergedSessionViewProp>;
  /** The session's commands (forks). The other fields of `actions` wrap or restrict them. */
  commandSet?: LabWorkbenchActions;
  /** The first input of a fork is still being sent: the view may only delete its message. */
  firstInputPending?: boolean;
  /** Wraps the commands outside Bot mode; the wrappers apply in merge order. */
  wrapActions?: (actions: LabWorkbenchActions) => LabWorkbenchActions;
  consoleCommands?: readonly SessionViewCommand[];
  /** Answers a command before the source is checked as current. */
  beforeSourceCheck?: ConsoleCommandHandler;
  /** Answers a command after the source is checked as current. */
  onConsoleCommand?: ConsoleCommandHandler;
  composerStatus?: ReactNode;
  composerContext?: ReactNode;
  composerNotice?: ReactNode;
  /** Keeps the view from sending while true. */
  blocksMutation?: boolean;
}

export interface SessionViewContributions {
  forks: SessionViewContribution;
  handoff: SessionViewContribution;
  quotes: SessionViewContribution;
  references: SessionViewContribution;
  /** Contributions that only set props of their own. */
  plain: readonly SessionViewContribution[];
  /** Notice about the outbox, which takes the composer notice before the forks do. */
  outbox: SessionViewContribution;
}

/**
 * Merge order, fixed:
 * - actions: Bot mode takes the forks' commands as they are; a fork whose first input is pending leaves only deleting
 *   its message; otherwise the quotes wrap the forks' commands, then the references wrap that.
 * - consoleCommands: forks, handoff, references.
 * - onExecuteConsoleCommand: the references' command first, with no source check; then the source is checked; then the
 *   handoff; then the forks (the Bot mode restriction, the wait for synchronisation, the fork itself).
 * - composerStatus: handoff progress, then the quote selection and notice.
 * - composerContext (not in Bot mode): references, then quote attachments.
 * - composerNotice: the outbox hint, else (not in Bot mode) the forks' entries.
 * - mutationBlocked: any contribution blocks it, or the Window is provisional.
 */
export function mergeSessionViewContributions(view: SessionViewContext, contributions: SessionViewContributions): SessionViewProps {
  const { forks, handoff, quotes, references, outbox, plain } = contributions;
  const { botPresentation } = view;
  const own = [forks, handoff, quotes, references, outbox, ...plain];
  const base = forks.commandSet!;
  const wrappers = [quotes, references].flatMap(item => item.wrapActions ? [item.wrapActions] : []);
  const actions = botPresentation ? base : forks.firstInputPending ? { deleteMessage: base.deleteMessage } : wrappers.reduce((current, wrap) => wrap(current), base);
  const answer = async (id: string, args: string): Promise<AgentCommandResult> => {
    const early = references.beforeSourceCheck?.(id, args);
    if (early) return early;
    view.assertCurrent();
    for (const item of [handoff, forks]) {
      const answered = item.onConsoleCommand?.(id, args);
      if (answered) return answered;
    }
    throw new Error(`No contribution answers the console command ${id}`);
  };
  const blocked = own.some(item => item.blocksMutation);
  return {
    ...Object.assign({}, ...own.map(item => item.props)),
    actions,
    consoleCommands: [forks, handoff, references].flatMap(item => item.consoleCommands ?? []),
    onExecuteConsoleCommand: answer,
    composerStatus: createElement(Fragment, null, handoff.composerStatus, quotes.composerStatus),
    composerContext: botPresentation ? undefined : createElement(Fragment, null, references.composerContext, quotes.composerContext),
    composerNotice: outbox.composerNotice ?? (botPresentation ? undefined : forks.composerNotice),
    mutationBlocked: blocked || view.provisional,
  };
}
