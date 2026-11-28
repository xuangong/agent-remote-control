import { windowSessionIdentity, type TaskView, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

/**
 * The bot workbench: a free Window bound to one bot, with tiles derived from the bot's live sessions.
 *
 * Contract
 * - Pure. The page passes the Window document, the bot's main session, the sub-sessions and answer sessions it holds, and the
 *   person's page-local state; what comes back is the tiles to draw. Nothing here writes a Window.
 * - The binding is the first `primary` view tagged `feature { kind: 'bot', id }`. A second tagged view is an ordinary view.
 * - Stored tiles (the Window's own views) come first, in stored order; derived tiles follow, by need: needs you, working, idle, and
 *   within a state the oldest start first. Ended sub-sessions fold into `ended` (newest first, at most ENDED_SHOWN).
 * - A session is one tile: a derived tile whose session a stored view shows is not derived, and the stored tile carries its state.
 * - A held tile keeps the slot it had in `previous`, and an ended held tile stays a tile (marked ended) until it is released.
 * - Derived tiles are folded unless the person expanded them. `tasks: undefined` is "not loaded", never "none".
 */
export const WORKBENCH_FEATURE = 'bot';
export const ENDED_SHOWN = 10;
/** The most sub-sessions a bot keeps alive; the person's own sides do not count toward it. */
export type WorkbenchLocator = { hostId: string; providerId: string; nativeSessionId: string };
export type WorkbenchState = TaskView['state'];

export interface WorkbenchTile {
  /** A stored tile's view id; a derived tile's `sub:<task id>`. */
  readonly id: string;
  readonly source: 'main' | 'stored' | 'derived';
  readonly title: string;
  readonly folded: boolean;
  readonly state?: WorkbenchState;
  readonly ended?: boolean;
  readonly mark?: 'you';
  readonly currentStep?: string;
  readonly lastWork?: string;
  readonly taskId?: string;
  readonly locator?: WorkbenchLocator;
  readonly view?: WindowView;
}
export interface AnswerSessionRow { readonly teamId: string; readonly conversation: string; readonly lastAt: number; readonly count: number }
export interface WorkbenchInput {
  readonly window: WorkspaceWindow;
  readonly botId: string | undefined;
  readonly mainSession: WorkbenchLocator | undefined;
  readonly tasks: readonly TaskView[] | undefined;
  readonly answers: readonly AnswerSessionRow[];
  /** Derived tiles the person expanded on this device. */
  readonly expanded: ReadonlySet<string>;
  /** Tiles the person is using: selected, focused, with an unsent draft. */
  readonly held: readonly string[];
  /** The derived tile ids of the previous model, in order. */
  readonly previous: readonly string[];
}
export interface WorkbenchModel {
  readonly botId: string | undefined;
  readonly main: WorkbenchTile | undefined;
  readonly stored: readonly WorkbenchTile[];
  readonly derived: readonly WorkbenchTile[];
  readonly ended: readonly WorkbenchTile[];
  readonly answers: readonly AnswerSessionRow[];
  readonly loaded: boolean;
  /** The bot's own live sub-sessions, which its limit counts. */
  readonly botSubSessions: number;
  readonly attention: { readonly needsYou: number; readonly working: number };
}

export const derivedTileId = (taskId: string) => `sub:${taskId}`;
export function workbenchMainView(window: Pick<WorkspaceWindow, 'views'>): WindowView | undefined {
  return window.views.find(view => view.placement === 'primary' && view.feature?.kind === WORKBENCH_FEATURE);
}
export const workbenchBotId = (window: Pick<WorkspaceWindow, 'views'>): string | undefined => workbenchMainView(window)?.feature?.id;

const identity = (locator: WorkbenchLocator) => windowSessionIdentity(locator);
const needRank: Record<WorkbenchState, number> = { needs_input: 0, working: 1, queued: 1, idle: 2, ended: 3 };

function tileOf(task: TaskView, input: WorkbenchInput, folded = !input.expanded.has(derivedTileId(task.taskId))): WorkbenchTile {
  const worker = task.worker.nativeSessionId ? { hostId: task.worker.hostId, providerId: task.worker.providerId, nativeSessionId: task.worker.nativeSessionId } : undefined;
  return { id: derivedTileId(task.taskId), source: 'derived', title: task.title, folded, state: task.state, taskId: task.taskId,
    ...(task.state === 'ended' ? { ended: true } : {}), ...(task.startedBy === 'person' ? { mark: 'you' as const } : {}),
    ...(task.currentStep ? { currentStep: task.currentStep } : {}), ...(task.lastWork ? { lastWork: task.lastWork.title } : {}), ...(worker ? { locator: worker } : {}) };
}

/** Moves each held tile back to the slot it had, so an automatic reorder never moves what the person is using. */
function holdSlots(natural: WorkbenchTile[], held: ReadonlySet<string>, previous: readonly string[]): WorkbenchTile[] {
  const kept = previous.filter(id => held.has(id) && natural.some(tile => tile.id === id));
  const result = natural.filter(tile => !kept.includes(tile.id));
  for (const id of kept) result.splice(Math.min(previous.indexOf(id), result.length), 0, natural.find(tile => tile.id === id)!);
  return result;
}

export function projectBotWorkbench(input: WorkbenchInput): WorkbenchModel {
  const { window, botId, tasks, held } = input;
  const mainView = botId ? workbenchMainView(window) : undefined;
  const heldSet = new Set(held);
  const storedViews = window.views.filter(view => view.placement === 'primary' && view !== mainView && !view.attachedTo);
  const stored: WorkbenchTile[] = storedViews.map(view => ({ id: view.id, source: 'stored', title: view.binding?.title ?? '', folded: view.collapsed, view,
    ...(view.binding ? { locator: { hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId } } : {}) }));
  const main: WorkbenchTile | undefined = mainView && { id: mainView.id, source: 'main', title: mainView.binding?.title ?? '', folded: mainView.collapsed, view: mainView,
    ...(input.mainSession ? { locator: input.mainSession } : {}) };
  if (!botId || !input.mainSession || !tasks) {
    return { botId, main, stored, derived: [], ended: [], answers: [...input.answers].sort((a, b) => b.lastAt - a.lastAt), loaded: !!tasks, botSubSessions: 0, attention: { needsYou: 0, working: 0 } };
  }
  const mainKey = identity(input.mainSession);
  const botOwned = tasks.filter(task => task.startedBy !== 'person' && identity(task.owner) === mainKey);
  const familyKeys = new Set([mainKey, ...botOwned.flatMap(task => task.worker.nativeSessionId ? [identity({ ...task.worker, nativeSessionId: task.worker.nativeSessionId })] : [])]);
  const yours = tasks.filter(task => task.startedBy === 'person' && familyKeys.has(identity(task.owner)));
  const mine = [...botOwned, ...yours];
  const storedByKey = new Map(stored.flatMap(tile => tile.locator ? [[identity(tile.locator), tile] as const] : []));
  const decorated = stored.map(tile => {
    const task = mine.find(item => item.worker.nativeSessionId && tile.locator && identity({ ...item.worker, nativeSessionId: item.worker.nativeSessionId }) === identity(tile.locator));
    return task ? { ...tile, state: task.state, taskId: task.taskId, ...(task.state === 'ended' ? { ended: true } : {}) } : tile;
  });
  const free = mine.filter(task => !(task.worker.nativeSessionId && storedByKey.has(identity({ ...task.worker, nativeSessionId: task.worker.nativeSessionId }))));
  const live = free.filter(task => task.state !== 'ended').sort((a, b) => needRank[a.state] - needRank[b.state] || a.createdAt - b.createdAt)
    .map(task => tileOf(task, input));
  const endedTasks = free.filter(task => task.state === 'ended').sort((a, b) => b.updatedAt - a.updatedAt);
  const heldEnded = endedTasks.filter(task => heldSet.has(derivedTileId(task.taskId)));
  const derived = holdSlots([...live, ...heldEnded.map(task => tileOf(task, input))], heldSet, input.previous);
  const ended = endedTasks.filter(task => !heldSet.has(derivedTileId(task.taskId))).slice(0, ENDED_SHOWN).map(task => tileOf(task, input));
  const count = (state: WorkbenchState) => mine.filter(task => task.state === state || state === 'working' && task.state === 'queued').length;
  return { botId, main, stored: decorated, derived, ended, answers: [...input.answers].sort((a, b) => b.lastAt - a.lastAt), loaded: true,
    botSubSessions: botOwned.filter(task => task.state !== 'ended').length, attention: { needsYou: count('needs_input'), working: count('working') } };
}
