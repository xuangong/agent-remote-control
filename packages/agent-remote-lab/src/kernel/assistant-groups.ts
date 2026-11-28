import { applyGroupOperation, applyWindowOperation, botViews, isBotView, mergeGroups, transferBot, windowPrimaryViewId, WindowGroupError, WINDOW_VIEW_LIMIT,
  type BotPicture, type WindowBotDetails, type WindowGroup, type WindowGroupEdit, type WindowGroupOperation, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { avatarWith } from '@orchardworks/agent-client-web/theme';
import type { AccountNames } from './assistant-names.js';
import { appendedRank, type BotRosterModel, type BotRow } from './bot-roster.js';
import { rankBetween } from './ranks.js';

/*
 * Groups as one concept (I5, owner 2026-11-22). A group is a Window group: Chats, the Assistants directory and Window mode list
 * the same groups in the same order. An assistant that belongs to no group of its own sits in the default group: New
 * assistant starts every assistant in a group of its own, named after its session, and that group stays its own until it is
 * renamed or the assistant moves into a group. This module holds the rules; the shells render what it returns.
 */

/**
 * The view a group of one assistant is named after: its one primary bot view whose session's title is the group's title.
 * `windowTitleEdits` keeps such a group's title following that session, so the group stays its assistant's own.
 */
export function personalView(group: WindowGroup): WindowView | undefined {
  const namesakes = group.window.views.filter(view => view.placement === 'primary' && isBotView(view) && view.binding.title === group.window.title);
  return namesakes.length === 1 ? namesakes[0] : undefined;
}
/** Whether a group is an assistant's own, so that its assistants sit in the default group. */
export const isPersonalGroup = (group: WindowGroup): boolean => !!personalView(group);

const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
interface Place { readonly group: WindowGroup; readonly index: number; readonly key: string; readonly ranked: boolean }
/**
 * Where each group is listed: by its rank, or, for a group without one, just after the group before it in the catalog (by that
 * group's rank, '' at the start), so groups made before ranks were used keep catalog order. A tie lists ranked groups first.
 */
function places(groups: readonly WindowGroup[]): Place[] {
  let previous = '';
  return groups.map((group, index) => {
    const rank = group.bots?.rank;
    if (rank !== undefined) previous = rank;
    return { group, index, key: rank ?? previous, ranked: rank !== undefined };
  });
}
const byPlace = (a: Place, b: Place) => lexical(a.key, b.key) || Number(b.ranked) - Number(a.ranked) || a.index - b.index;
/** The groups people made, in their order; the groups of one assistant are not among them (they form the default group). */
export function orderedGroups(groups: readonly WindowGroup[]): WindowGroup[] {
  return places(groups).filter(place => !isPersonalGroup(place.group)).sort(byPlace).map(place => place.group);
}
/** A rank that keeps a group where it is listed, for a group that becomes a section (`bots.add`) without moving. */
export function rankInPlace(groups: readonly WindowGroup[], groupId: string): string {
  const all = places(groups), own = all.find(place => place.group.window.id === groupId);
  if (!own || own.ranked) return appendedRank(groups);
  const next = all.filter(place => place.ranked && place.key > own.key).map(place => place.key).sort().at(0);
  return rankBetween(own.key || undefined, next) ?? appendedRank(groups);
}

/** Window mode's list in the same order: the groups people made, then the assistants' own groups, each in catalog order. */
export function inGroupOrder<T extends { readonly id: string }>(windows: readonly T[], groups: readonly WindowGroup[]): T[] {
  const position = new Map(orderedGroups(groups).map((group, index) => [group.window.id, index]));
  const place = (id: string) => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return windows.map((window, index) => ({ window, index })).sort((a, b) => place(a.window.id) - place(b.window.id) || a.index - b.index).map(item => item.window);
}

/** How many reminders a group's assistants send: both (needs you and finished), or only needs you. */
export type GroupNotifications = 'all' | 'needs_you';
/** One group as Chats, the directory and Window mode show it. */
export interface GroupSection {
  /** The stored group; absent for the default group, which gathers the assistants that are in no group of their own. */
  readonly groupId?: string;
  readonly title: string;
  readonly rows: readonly BotRow[];
  readonly muted?: true;
  readonly notifications?: 'needs_you';
  /** A chat in the group has a reply the owner has not seen, and it is not muted. */
  readonly unread?: true;
  /** Only in the directory: the group is hidden in Chats. */
  readonly hiddenInChats?: true;
}

/**
 * The primary bot first, then pinned chats, then by the time of the latest reply, newest first; chats that never replied keep roster order after them.
 * A send moves its chat when the assistant answers, so the list does not jump while assistants work.
 */
function byActivity(rows: readonly BotRow[]): BotRow[] {
  return rows.map((row, order) => ({ row, order })).sort((a, b) => Number(!!b.row.details.primary) - Number(!!a.row.details.primary) || Number(!!b.row.details.pinned) - Number(!!a.row.details.pinned)
    || (b.row.reply?.replyAt ?? -1) - (a.row.reply?.replyAt ?? -1) || a.order - b.order).map(item => item.row);
}

/**
 * The sections of Chats (`order: 'activity'`) or of the directory (`order: 'roster'`): the groups people made in their order,
 * then the default group. Chats leave out a group with no chat; the directory keeps an empty group made in Bot mode.
 * `defaultTitle` names the default group in the reader's words.
 */
export function groupSections(model: BotRosterModel, groups: readonly WindowGroup[], options: { order: 'activity' | 'roster'; defaultTitle: string }): GroupSection[] {
  const byId = new Map(groups.map(group => [group.window.id, group]));
  const projected = new Map(model.sections.map(section => [section.groupId, section]));
  const ordered = (rows: readonly BotRow[]) => options.order === 'activity' ? byActivity(rows) : [...rows];
  const unread = (rows: readonly BotRow[]) => rows.some(row => row.unread && !row.muted) ? { unread: true as const } : {};
  const named = orderedGroups(groups).flatMap((group): GroupSection[] => {
    const section = projected.get(group.window.id);
    if (!section || options.order === 'activity' && !section.rows.length) return [];
    return [{ groupId: group.window.id, title: group.window.title, rows: ordered(section.rows), ...unread(section.rows),
      ...(group.bots?.muted ? { muted: true as const } : {}), ...(group.bots?.notifications === 'needs_you' ? { notifications: 'needs_you' as const } : {}),
      ...(section.hiddenInChats ? { hiddenInChats: true as const } : {}) }];
  });
  // The default group lists the assistants of every group of one, in catalog order before Chats orders them by activity.
  const personal = model.sections.filter(section => { const group = byId.get(section.groupId); return !!group && isPersonalGroup(group); }).flatMap(section => section.rows);
  const sections = personal.length ? [...named, { title: options.defaultTitle, rows: ordered(personal), ...unread(personal) }] : named;
  // The section of the primary bot leads Chats; the directory keeps the groups' order.
  return options.order === 'activity' ? [...sections.filter(section => section.rows.some(row => row.details.primary)), ...sections.filter(section => !section.rows.some(row => row.details.primary))] : sections;
}
/** Chats show no headings while one group is all there is, as a plain list. */
export const showsGroupHeadings = (sections: readonly GroupSection[]): boolean => sections.length > 1;

/** The reminders a page shows for an assistant: needs you, and a finished turn. The rule is the protocol's, which the Relay's pushes follow too. */
export { assistantReminders, type AssistantReminder as Reminder } from '@orchardworks/agent-remote-protocol';

/** One change of a reorder: a group's new rank (`section.rank`, or `bots.add` for a group without a section). */
export interface GroupRankChange { readonly groupId: string; readonly operation: WindowGroupOperation }
const rankChange = (group: WindowGroup, rank: string): GroupRankChange => ({ groupId: group.window.id, operation: group.bots ? { type: 'section.rank', rank } : { type: 'bots.add', rank } });
/**
 * The changes that move a group one place up (-1) or down (1) among `ordered`, the groups as listed; `groups` is the catalog.
 * Usually one: a rank between its new neighbours. When groups without a rank leave no room between them, those groups get
 * ranks in the order shown first, so the move still takes one place. Undefined at either end.
 */
export function reorderGroup(groups: readonly WindowGroup[], ordered: readonly WindowGroup[], groupId: string, step: -1 | 1): GroupRankChange[] | undefined {
  const index = ordered.findIndex(group => group.window.id === groupId), target = index + step;
  if (index < 0 || target < 0 || target >= ordered.length) return undefined;
  const moving = ordered[index]!, others = ordered.filter(group => group !== moving);
  const between = (rankOf: (group: WindowGroup) => string | undefined) => {
    const before = others[target - 1], after = others[target];
    const low = before ? rankOf(before) || undefined : undefined, high = after ? rankOf(after) : undefined;
    return high === '' ? undefined : rankBetween(low, high);
  };
  // A change is kept only if it lists the groups as asked: a group without a rank follows the group before it in the catalog.
  const expected = [...others.map(group => group.window.id)]; expected.splice(target, 0, moving.window.id);
  const shown = new Set(expected);
  const lists = (changes: readonly GroupRankChange[]) => {
    try {
      const next = groups.map(group => changes.filter(change => change.groupId === group.window.id).reduce((value, change) => applyGroupOperation(value, change.operation), group));
      return JSON.stringify(orderedGroups(next).map(group => group.window.id).filter(id => shown.has(id))) === JSON.stringify(expected);
    } catch { return false; }
  };
  const keys = new Map(places(groups).map(place => [place.group.window.id, place.key]));
  const direct = between(group => keys.get(group.window.id));
  if (direct && lists([rankChange(moving, direct)])) return [rankChange(moving, direct)];
  // Ranks for every listed group in the order shown; a group without one, or out of order, gets one between its neighbours.
  const ranks = new Map<WindowGroup, string>();
  let floor: string | undefined;
  for (const [position, group] of ordered.entries()) {
    const own = group.bots?.rank;
    if (own !== undefined && (floor === undefined || own > floor)) { ranks.set(group, own); floor = own; continue; }
    const ceiling = ordered.slice(position + 1).map(next => next.bots?.rank).find(rank => rank !== undefined && (floor === undefined || rank > floor));
    const rank = rankBetween(floor, ceiling);
    if (!rank) return undefined;
    ranks.set(group, rank); floor = rank;
  }
  const rank = between(group => ranks.get(group));
  if (!rank) return undefined;
  ranks.set(moving, rank);
  const changes = ordered.flatMap(group => ranks.get(group) === group.bots?.rank ? [] : [rankChange(group, ranks.get(group)!)]);
  return lists(changes) ? changes : undefined;
}

/** An assistant by its place: the group it is in and its view there. */
export interface AssistantPlace { readonly groupId: string; readonly viewId: string }
/** One request of a move, in order: an edit of a group, a new group, or a move between groups (the Relay's transfer or merge). */
export type MoveStep =
  | { readonly kind: 'edit'; readonly groupId: string; readonly operation: WindowGroupOperation }
  | { readonly kind: 'create'; readonly group: WindowGroup }
  | { readonly kind: 'transfer'; readonly source: string; readonly target: string; readonly viewId: string }
  | { readonly kind: 'merge'; readonly source: string; readonly target: string };
/** Why an assistant cannot move: it is gone, it is a Side (it moves with the assistant it is beside), a Team or Support member, or the group is full. */
export type MoveRefusal = 'missing' | 'side' | 'managed' | 'full' | 'invalid';
export type MovePlan = { readonly steps: readonly MoveStep[]; readonly place: AssistantPlace } | { readonly refused: MoveRefusal };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The ids of the views that leave with a view when it closes: itself, its Sides and what closes with them. */
function leavingWith(window: WorkspaceWindow, viewId: string): Set<string> {
  const staying = new Set(applyWindowOperation(window, { type: 'view.close', viewId }).views.map(view => view.id));
  return new Set(window.views.filter(view => !staying.has(view.id)).map(view => view.id));
}
/** The picture an assistant shows now, stored, so it keeps its face when its view or group changes. */
function shownPicture(viewId: string, picture: BotPicture | undefined): BotPicture {
  const { shape, color, gaze } = avatarWith(viewId, picture);
  return { shape, color, ...(gaze === undefined ? {} : { gaze }) } as BotPicture;
}

/**
 * Prepares the views that leave `group` for another group: each bot keeps the name and face it has now (they follow its group
 * and view when not stored), and a view whose id the other group already has gets a new id, with every reference to it.
 * `primary` makes that view a primary one, so that the group of one it starts is named after it. A group that sends a bot
 * away by transfer must be a section (`section`); `rank` places it when it becomes one.
 */
function prepare(group: WindowGroup, leaving: ReadonlySet<string>, taken: ReadonlySet<string>, context: { names: AccountNames; newId(): string; rank: string; section: boolean; primary?: string }): { operation?: WindowGroupOperation; ids: Map<string, string> } {
  const ids = new Map([...leaving].filter(id => taken.has(id)).map(id => [id, context.newId()]));
  const id = (value: string) => ids.get(value) ?? value;
  const edits: WindowGroupEdit[] = [];
  const primary = context.primary, replaced = primary !== undefined && group.window.views.find(view => view.id === primary)?.placement !== 'primary';
  if (ids.size || replaced) {
    const views = group.window.views.map((view): WindowView => {
      const next: WindowView = { ...clone(view), id: id(view.id), ...(view.attachedTo ? { attachedTo: id(view.attachedTo) } : {}), ...(view.closeWith ? { closeWith: id(view.closeWith) } : {}) };
      if (view.id !== primary || view.placement === 'primary') return next;
      const { closeWith: _closeWith, ...rest } = next;
      return { ...rest, placement: 'primary' };
    });
    const selectedViewId = group.window.selectedViewId === null ? null : id(group.window.selectedViewId);
    const draft = { ...group.window, views, selectedViewId };
    const previous = group.window.selectedPrimaryViewId === null ? undefined : id(group.window.selectedPrimaryViewId);
    // The selected view's primary leads; otherwise the primary selected before, or the first one.
    const selectedPrimaryViewId = windowPrimaryViewId(draft, selectedViewId) ?? previous ?? views.find(view => view.placement === 'primary')?.id ?? null;
    edits.push({ type: 'layout.apply', layout: { title: group.window.title, views, selectedViewId, selectedPrimaryViewId } });
  }
  for (const view of botViews(group).filter(view => leaving.has(view.id))) {
    const details = group.bots?.members[view.id] ?? {};
    if (!ids.has(view.id) && details.name && details.picture) continue;
    edits.push({ type: 'bot.update', viewId: id(view.id), details: { ...clone(details), name: details.name ?? context.names.view(group.window.id, view.id), picture: details.picture ?? shownPicture(view.id, undefined) } });
  }
  if (!group.bots && (context.section || edits.some(edit => edit.type === 'bot.update'))) edits.unshift({ type: 'bots.add', rank: context.rank });
  return { ...(edits.length ? { operation: edits.length === 1 ? edits[0]! : { type: 'batch', operations: edits } } : {}), ids };
}

/**
 * How an assistant moves to another group (`to`), or into the default group (`to` absent). Out of its group of one it takes
 * that whole group along (a merge, which leaves nothing behind); out of a group of several it moves with its Sides and what
 * closes with it (a transfer). Into the default group it gets a group of one, named after its session. Each step is checked
 * here against the same rules the Relay applies, so a refused move sends nothing.
 */
export function planMove(groups: readonly WindowGroup[], from: AssistantPlace, to: string | undefined, context: { names: AccountNames; newId(): string }): MovePlan {
  const source = groups.find(group => group.window.id === from.groupId);
  const view = source?.window.views.find(item => item.id === from.viewId);
  if (!source || !view || !isBotView(view)) return { refused: 'missing' };
  if (view.placement === 'attached') return { refused: 'side' };
  if (view.feature || view.bindingPolicy === 'managed') return { refused: 'managed' };
  const own = personalView(source)?.id === view.id;
  if (to === source.window.id || to === undefined && isPersonalGroup(source)) return { steps: [], place: from };
  try {
    if (to === undefined) {
      const created: WindowGroup = { window: { schemaVersion: 3, id: context.newId(), revision: 0, title: view.binding.title, selectedPrimaryViewId: null, selectedViewId: null, views: [] },
        bots: { rank: appendedRank(groups), members: {} } };
      const prepared = prepare(source, leavingWith(source.window, view.id), new Set(), { ...context, rank: rankInPlace(groups, source.window.id), section: true, primary: view.id });
      const ready = prepared.operation ? applyGroupOperation(source, prepared.operation) : source;
      transferBot(ready, created, view.id);
      return { steps: [...(prepared.operation ? [{ kind: 'edit' as const, groupId: source.window.id, operation: prepared.operation }] : []),
        { kind: 'create', group: created }, { kind: 'transfer', source: source.window.id, target: created.window.id, viewId: view.id }],
        place: { groupId: created.window.id, viewId: view.id } };
    }
    const target = groups.find(group => group.window.id === to);
    if (!target) return { refused: 'missing' };
    const leaving = own ? new Set(source.window.views.map(item => item.id)) : leavingWith(source.window, view.id);
    if (target.window.views.length + leaving.size > WINDOW_VIEW_LIMIT) return { refused: 'full' };
    const prepared = prepare(source, leaving, new Set(target.window.views.map(item => item.id)), { ...context, rank: rankInPlace(groups, source.window.id), section: !own });
    const ready = prepared.operation ? applyGroupOperation(source, prepared.operation) : source;
    const viewId = prepared.ids.get(view.id) ?? view.id;
    const section: WindowGroupOperation | undefined = !own && !target.bots ? { type: 'bots.add', rank: rankInPlace(groups, target.window.id) } : undefined;
    const receiving = section ? applyGroupOperation(target, section) : target;
    if (own) mergeGroups(receiving, ready); else transferBot(ready, receiving, viewId);
    return { steps: [...(prepared.operation ? [{ kind: 'edit' as const, groupId: source.window.id, operation: prepared.operation }] : []),
      ...(section ? [{ kind: 'edit' as const, groupId: target.window.id, operation: section }] : []),
      own ? { kind: 'merge', source: source.window.id, target: target.window.id } : { kind: 'transfer', source: source.window.id, target: target.window.id, viewId }],
      place: { groupId: target.window.id, viewId } };
  } catch {
    return { refused: 'invalid' };
  }
}

/**
 * The steps of a move applied by the protocol's own rules, as the Relay applies them, for a page without a Relay: a merged
 * group is gone afterwards. A step on a group that is not there is refused.
 */
export function applyMoveSteps(groups: readonly WindowGroup[], steps: readonly MoveStep[]): WindowGroup[] {
  let state = [...groups];
  const find = (id: string) => state.find(item => item.window.id === id) ?? (() => { throw new WindowGroupError('window_not_found', 'This group no longer exists.'); })();
  const replace = (...changed: WindowGroup[]) => { state = state.map(old => changed.find(item => item.window.id === old.window.id) ?? old); };
  for (const step of steps) {
    if (step.kind === 'edit') replace(applyGroupOperation(find(step.groupId), step.operation));
    else if (step.kind === 'create') state = [...state, step.group];
    else if (step.kind === 'transfer') { const moved = transferBot(find(step.source), find(step.target), step.viewId); replace(moved.source, moved.target); }
    else { const merged = mergeGroups(find(step.target), find(step.source)); state = state.filter(item => item.window.id !== step.source); replace(merged); }
  }
  return state;
}
