import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { WINDOW_VIEW_LIMIT, WindowEdit, WorkspaceWindow, isWorkspaceWindow, type WindowSessionBinding, type WindowView } from './window-workspace.js';
import { WindowLayoutError, applyWindowOperation } from './window-workspace-operations.js';

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** A fractional index: ranks compare as strings and never end in 0, so a new one fits between any two others until the length limit. */
const rank = Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9a-z]*[1-9a-z]$' });

/** What Bot mode shows for one bot beyond its session's title. */
export const WindowBotDetails = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  picture: Type.Optional(Type.Object({
    shape: Type.Union([Type.Literal('circle'), Type.Literal('rounded'), Type.Literal('hexagon')]),
    color: Type.String({ pattern: '^#[0-9a-f]{6}$' }),
  }, strict)),
  pinned: Type.Optional(Type.Literal(true)),
  hidden: Type.Optional(Type.Literal(true)),
  rank: Type.Optional(rank),
}, strict);
export type WindowBotDetails = Static<typeof WindowBotDetails>;
/** A group's section in Bot mode. Bots without details use their defaults. */
export const WindowBots = Type.Object({
  rank,
  members: Type.Record(Type.String({ pattern: '^[A-Za-z0-9_.:-]{1,128}$' }), WindowBotDetails, { maxProperties: WINDOW_VIEW_LIMIT, additionalProperties: false }),
}, strict);
export type WindowBots = Static<typeof WindowBots>;
/** Present only for a group that is not shown as a Window. */
export const WindowPresentation = Type.Object({ window: Type.Literal(false) }, strict);
export type WindowPresentation = Static<typeof WindowPresentation>;
/** One grouping of sessions: a Window document and the appearances it is managed in. */
export const WindowGroup = Type.Object({ window: WorkspaceWindow, bots: Type.Optional(WindowBots), presentation: Type.Optional(WindowPresentation) }, strict);
export type WindowGroup = Static<typeof WindowGroup>;

const GroupEdit = Type.Union([
  Type.Object({ type: Type.Literal('bots.add'), rank }, strict),
  Type.Object({ type: Type.Literal('bots.remove') }, strict),
  Type.Object({ type: Type.Literal('window.add') }, strict),
  Type.Object({ type: Type.Literal('window.remove') }, strict),
  /** Replaces the bot's details. */
  Type.Object({ type: Type.Literal('bot.update'), viewId: id, details: WindowBotDetails }, strict),
  Type.Object({ type: Type.Literal('section.rank'), rank }, strict),
]);
export const WindowGroupEdit = Type.Union([...WindowEdit.anyOf, ...GroupEdit.anyOf]);
export type WindowGroupEdit = Static<typeof WindowGroupEdit>;
export const WindowGroupOperation = Type.Union([WindowGroupEdit,
  Type.Object({ type: Type.Literal('batch'), operations: Type.Array(WindowGroupEdit, { minItems: 1, maxItems: 128 }) }, strict)]);
export type WindowGroupOperation = Static<typeof WindowGroupOperation>;
export const WindowGroupMutation = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, operation: WindowGroupOperation }, strict);
export type WindowGroupMutation = Static<typeof WindowGroupMutation>;
export const WindowGroupCreateRequest = Type.Object({ operationId: id, issuedAt: counter, window: WorkspaceWindow,
  bots: Type.Optional(WindowBots), presentation: Type.Optional(WindowPresentation) }, strict);
export type WindowGroupCreateRequest = Static<typeof WindowGroupCreateRequest>;
/** Sent to the target group: the source group's views join it and the source is deleted. */
export const WindowMergeRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, source: id, sourceRevision: counter }, strict);
export type WindowMergeRequest = Static<typeof WindowMergeRequest>;
/** Sent to a group that is both a Window and a section: the section moves to a new group. */
export const WindowSplitRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, newId: id }, strict);
export type WindowSplitRequest = Static<typeof WindowSplitRequest>;
/** Sent to the source group: one bot, its attached views and its details move to the target section. */
export const WindowTransferRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, viewId: id, target: id, targetRevision: counter }, strict);
export type WindowTransferRequest = Static<typeof WindowTransferRequest>;

/** A refusal by a group rule; its code reaches clients unlike other layout errors. */
export class WindowGroupError extends WindowLayoutError {
  constructor(code: string, message: string) { super(code, message); this.name = 'WindowGroupError'; }
}

/** A bot is an ordinary view showing a current session: not attached, not history, not a subagent's, not an Ask, Team or TPM view. */
export function isBotView(view: WindowView): view is WindowView & { binding: WindowSessionBinding } {
  return view.placement !== 'attached' && view.binding !== undefined && view.binding.sessionIntent === undefined
    && view.binding.parentNativeSessionId === undefined && view.feature === undefined && view.bindingPolicy !== 'managed';
}
export const windowSessionIdentity = (binding: Pick<WindowSessionBinding, 'hostId' | 'providerId' | 'nativeSessionId'>) =>
  JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]);
/** The views Bot mode shows as bots: none for a group that is not a section. */
export function groupBotViews(group: WindowGroup): Array<WindowView & { binding: WindowSessionBinding }> {
  return group.bots ? group.window.views.filter(isBotView) : [];
}
export const hasWindowAppearance = (group: WindowGroup): boolean => group.presentation?.window !== false;

export function isWindowGroup(value: unknown): value is WindowGroup {
  if (!Value.Check(WindowGroup, value) || !isWorkspaceWindow(value.window)) return false;
  if (!hasWindowAppearance(value) && !value.bots) return false;
  const bots = new Set(groupBotViews(value).map(view => view.id));
  return Object.keys(value.bots?.members ?? {}).every(viewId => bots.has(viewId));
}
export const isWindowGroupMutation = (value: unknown): value is WindowGroupMutation => Value.Check(WindowGroupMutation, value);
export const isWindowGroupCreateRequest = (value: unknown): value is WindowGroupCreateRequest => Value.Check(WindowGroupCreateRequest, value)
  && isWindowGroup({ window: value.window, ...(value.bots ? { bots: value.bots } : {}), ...(value.presentation ? { presentation: value.presentation } : {}) });
export const isWindowMergeRequest = (value: unknown): value is WindowMergeRequest => Value.Check(WindowMergeRequest, value);
export const isWindowSplitRequest = (value: unknown): value is WindowSplitRequest => Value.Check(WindowSplitRequest, value);
export const isWindowTransferRequest = (value: unknown): value is WindowTransferRequest => Value.Check(WindowTransferRequest, value);

function fail(code: string, message: string): never { throw new WindowGroupError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Drops the details of views that are no longer bots, such as a closed view or one now showing history. */
function pruned(group: WindowGroup): WindowGroup {
  if (!group.bots) return group;
  const bots = new Set(groupBotViews(group).map(view => view.id));
  return { ...group, bots: { ...group.bots, members: Object.fromEntries(Object.entries(group.bots.members).filter(([viewId]) => bots.has(viewId))) } };
}

function edit(group: WindowGroup, item: WindowGroupEdit): WindowGroup {
  switch (item.type) {
    case 'bots.add':
      if (group.bots) fail('section_exists', 'This group is already a section.');
      return { ...group, bots: { rank: item.rank, members: {} } };
    case 'bots.remove': {
      if (!group.bots) fail('section_missing', 'This group is not a section.');
      if (!hasWindowAppearance(group)) fail('last_appearance', 'A group stays a Window or a section; add the other first.');
      const { bots: _bots, ...rest } = group;
      return rest;
    }
    case 'window.add': {
      if (hasWindowAppearance(group)) fail('window_exists', 'This group is already a Window.');
      const { presentation: _presentation, ...rest } = group;
      return rest;
    }
    case 'window.remove':
      if (!hasWindowAppearance(group)) fail('window_missing', 'This group is not a Window.');
      if (!group.bots) fail('last_appearance', 'A group stays a Window or a section; add the other first.');
      return { ...group, presentation: { window: false } };
    case 'bot.update': {
      const view = group.window.views.find(candidate => candidate.id === item.viewId);
      if (!group.bots || !view || !isBotView(view)) fail('bot_not_found', 'This bot no longer exists.');
      return { ...group, bots: { ...group.bots, members: { ...group.bots.members, [item.viewId]: clone(item.details) } } };
    }
    case 'section.rank':
      if (!group.bots) fail('section_missing', 'This group is not a section.');
      return { ...group, bots: { ...group.bots, rank: item.rank } };
    default: {
      if (item.type === 'view.bind' && group.bots) {
        const view = group.window.views.find(candidate => candidate.id === item.viewId);
        // Rule 1: a bot keeps its conversation; the title and role details of that session may change.
        if (view && isBotView(view) && (!isBotView({ ...view, binding: item.binding })
          || windowSessionIdentity(view.binding) !== windowSessionIdentity(item.binding))) {
          fail('bot_view', 'A bot keeps its conversation. Open the other session beside it.');
        }
      }
      return { ...group, window: applyWindowOperation(group.window, item) };
    }
  }
}

/** Applies one explicit command atomically and advances the Window revision once, as applyWindowOperation does. */
export function applyGroupOperation(source: WindowGroup, operation: WindowGroupOperation): WindowGroup {
  if (!isWindowGroup(source) || !Value.Check(WindowGroupOperation, operation)) fail('invalid_window_operation', 'The group or operation is invalid.');
  let result = clone(source);
  for (const item of operation.type === 'batch' ? operation.operations : [operation]) result = edit(result, item);
  result = pruned({ ...result, window: { ...result.window, revision: source.window.revision + 1 } });
  if (!isWindowGroup(result)) fail('invalid_window_group', 'The resulting group is invalid.');
  return result;
}
