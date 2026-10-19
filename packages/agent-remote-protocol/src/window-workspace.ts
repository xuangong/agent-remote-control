import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' });
const nativeId = Type.String({ minLength: 1, maxLength: 4096 });
const title = Type.String({ minLength: 1, maxLength: 512 });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const width = Type.Number({ minimum: 240, maximum: 1600 });
export const WINDOW_VIEW_LIMIT = 64;
export const WINDOW_DOCUMENT_MAX_BYTES = 256 * 1024;
export const WINDOW_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export const WindowSessionBinding = Type.Object({
  hostId: nativeId, providerId: nativeId, nativeSessionId: nativeId, title,
  parentNativeSessionId: Type.Optional(nativeId),
  sessionIntent: Type.Optional(Type.Literal('history')),
  role: Type.Optional(Type.Object({ controllerId: nativeId, roleId: nativeId, revision: counter }, strict)),
}, strict);
export type WindowSessionBinding = Static<typeof WindowSessionBinding>;
export const WindowViewDisplay = Type.Object({ mode: Type.Union([Type.Literal('preview'), Type.Literal('simple'), Type.Literal('content')]), lettersVisible: Type.Boolean() }, strict);
export type WindowViewDisplay = Static<typeof WindowViewDisplay>;
export const WindowViewGeometry = Type.Object({ x: Type.Number({ minimum: 0, maximum: 100000 }), y: Type.Number({ minimum: 0, maximum: 100000 }), width,
  height: Type.Number({ minimum: 120, maximum: 4000 }) }, strict);
export const WindowView = Type.Object({
  id, binding: Type.Optional(WindowSessionBinding), attachedTo: Type.Optional(id), closeWith: Type.Optional(id),
  bindingPolicy: Type.Optional(Type.Union([Type.Literal('replaceable'), Type.Literal('managed')])),
  feature: Type.Optional(Type.Object({
    kind: id,
    id: nativeId,
    metadata: Type.Optional(Type.Record(Type.String({ pattern: '^.{1,64}$' }), Type.String({ maxLength: 4096 }), { maxProperties: 16, additionalProperties: false })),
  }, strict)),
  placement: Type.Union([Type.Literal('primary'), Type.Literal('dock'), Type.Literal('float'), Type.Literal('attached')]),
  width, collapsed: Type.Boolean(), display: WindowViewDisplay, geometry: Type.Optional(WindowViewGeometry),
}, strict);
export type WindowView = Static<typeof WindowView>;
const selection = Type.Union([id, Type.Null()]);
export const WindowLayout = Type.Object({ title, selectedPrimaryViewId: selection, selectedViewId: selection,
  views: Type.Array(WindowView, { maxItems: WINDOW_VIEW_LIMIT }) }, strict);
export type WindowLayout = Static<typeof WindowLayout>;
export const WorkspaceWindow = Type.Object({ schemaVersion: Type.Literal(3), id, revision: counter, ...WindowLayout.properties }, strict);
export type WorkspaceWindow = Static<typeof WorkspaceWindow>;

export const WindowEdit = Type.Union([
  Type.Object({ type: Type.Literal('rename'), title }, strict),
  Type.Object({ type: Type.Literal('view.create'), view: WindowView }, strict),
  Type.Object({ type: Type.Literal('view.bind'), viewId: id, binding: WindowSessionBinding,
    expectedBinding: Type.Optional(Type.Union([WindowSessionBinding, Type.Null()])) }, strict),
  Type.Object({ type: Type.Literal('view.close'), viewId: id }, strict),
  Type.Object({ type: Type.Literal('view.select'), viewId: id }, strict),
  Type.Object({ type: Type.Literal('view.move'), viewId: id, afterId: id }, strict),
  Type.Object({ type: Type.Literal('view.resize'), viewId: id, width }, strict),
  Type.Object({ type: Type.Literal('view.place'), viewId: id, placement: Type.Union([Type.Literal('dock'), Type.Literal('float')]) }, strict),
  Type.Object({ type: Type.Literal('view.collapse'), viewId: id, collapsed: Type.Boolean() }, strict),
  Type.Object({ type: Type.Literal('view.display'), viewId: id, display: WindowViewDisplay }, strict),
  Type.Object({ type: Type.Literal('view.geometry'), viewId: id, geometry: WindowViewGeometry }, strict),
  Type.Object({ type: Type.Literal('layout.apply'), layout: WindowLayout }, strict),
]);
export type WindowEdit = Static<typeof WindowEdit>;
export const WindowOperation = Type.Union([WindowEdit, Type.Object({ type: Type.Literal('batch'), operations: Type.Array(WindowEdit, { minItems: 1, maxItems: 128 }) }, strict)]);
export type WindowOperation = Static<typeof WindowOperation>;
export const WindowMutation = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, operation: WindowOperation }, strict);
export type WindowMutation = Static<typeof WindowMutation>;
export const WindowOperationResult = Type.Object({ operationId: id, status: Type.Union([Type.Literal('committed'), Type.Literal('rejected')]), revision: counter,
  committedAt: counter, expiresAt: counter, code: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), message: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })) }, strict);
export type WindowOperationResult = Static<typeof WindowOperationResult>;
export const WindowCreateRequest = Type.Object({ operationId: id, issuedAt: counter, window: WorkspaceWindow }, strict);
export type WindowCreateRequest = Static<typeof WindowCreateRequest>;
export const WindowDeleteRequest = Type.Object({ operationId: id, issuedAt: counter, baseRevision: counter, operation: Type.Object({ type: Type.Literal('delete') }, strict) }, strict);
export type WindowDeleteRequest = Static<typeof WindowDeleteRequest>;

export const isWindowSessionBinding = (value: unknown): value is WindowSessionBinding => Value.Check(WindowSessionBinding, value);
export const isWindowView = (value: unknown): value is WindowView => Value.Check(WindowView, value);
export const isWindowOperation = (value: unknown): value is WindowOperation => Value.Check(WindowOperation, value);
export const isWindowMutation = (value: unknown): value is WindowMutation => Value.Check(WindowMutation, value);
export const isWindowOperationResult = (value: unknown): value is WindowOperationResult => Value.Check(WindowOperationResult, value);
export const isWindowDeleteRequest = (value: unknown): value is WindowDeleteRequest => Value.Check(WindowDeleteRequest, value);
export const isWindowCreateRequest = (value: unknown): value is WindowCreateRequest => Value.Check(WindowCreateRequest, value) && isWorkspaceWindow((value as WindowCreateRequest).window);

/** Structural references describe presentation; native sessions remain separately authoritative. */
export function isWorkspaceWindow(value: unknown): value is WorkspaceWindow {
  if (!Value.Check(WorkspaceWindow, value)) return false;
  const window = value as WorkspaceWindow;
  // Count UTF-8 bytes without allocating a second encoded document.
  const json = JSON.stringify(window);
  let bytes = 0;
  for (const c of json) { const n = c.codePointAt(0)!; bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4; }
  if (bytes > WINDOW_DOCUMENT_MAX_BYTES) return false;
  const views = new Map(window.views.map(view => [view.id, view]));
  if (views.size !== window.views.length) return false;
  if (!views.size) return window.selectedViewId === null && window.selectedPrimaryViewId === null;
  if (window.selectedViewId === null || !views.has(window.selectedViewId)) return false;
  if (window.views.some(view => view.placement === 'primary')) {
    if (window.selectedPrimaryViewId === null || views.get(window.selectedPrimaryViewId)?.placement !== 'primary') return false;
  } else if (window.selectedPrimaryViewId !== null) return false;
  const selectedPrimary = windowPrimaryViewId(window, window.selectedViewId);
  if (selectedPrimary && selectedPrimary !== window.selectedPrimaryViewId) return false;
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (current: string): boolean => {
    if (visited.has(current)) return true;
    const item = views.get(current);
    if (!item || active.has(current)) return false;
    active.add(current);
    if (![item.attachedTo, item.closeWith].every(parent => !parent || visit(parent))) return false;
    active.delete(current); visited.add(current); return true;
  };
  // Each attachment subtree occupies one contiguous interval after its source.
  const ancestry: string[] = [];
  const attachedSources = new Set<string>();
  for (const view of window.views) {
    if ((view.placement === 'attached') !== (view.attachedTo !== undefined)) return false;
    if (view.placement === 'primary' && (view.attachedTo || view.closeWith)) return false;
    if (!visit(view.id)) return false;
    if (view.attachedTo) {
      if (attachedSources.has(view.attachedTo)) return false;
      attachedSources.add(view.attachedTo);
      const parent = ancestry.indexOf(view.attachedTo);
      if (parent < 0) return false;
      ancestry.length = parent + 1;
    } else ancestry.length = 0;
    ancestry.push(view.id);
  }
  return true;
}

/** Primary roots define Session groups; lifecycle and feature tags do not establish membership. */
export function primaryWindowViews(window: WorkspaceWindow): WindowView[] {
  return window.views.filter(view => view.placement === 'primary');
}
export function windowPrimaryViewId(window: WorkspaceWindow, viewId: string | null): string | undefined {
  const visited = new Set<string>();
  let view = window.views.find(view => view.id === viewId);
  while (view && !visited.has(view.id)) {
    if (view.placement === 'primary') return view.id;
    visited.add(view.id);
    view = view.attachedTo ? window.views.find(candidate => candidate.id === view!.attachedTo) : undefined;
  }
}

const LegacyWorkspaceWindow = Type.Object({ schemaVersion: Type.Literal(1), id, revision: counter, title,
  primaryViewId: id, selectedViewId: id, mainMinimized: Type.Boolean(), views: Type.Array(WindowView, { minItems: 1, maxItems: WINDOW_VIEW_LIMIT }) }, strict);
const PreviousWorkspaceWindow = Type.Object({ schemaVersion: Type.Literal(2), id, revision: counter, title,
  selectedPrimaryViewId: id, selectedViewId: id, views: Type.Array(WindowView, { minItems: 1, maxItems: WINDOW_VIEW_LIMIT }) }, strict);
/** Decode persisted snapshots without changing layout identity or operation revisions. */
export function decodeWorkspaceWindow(value: unknown): WorkspaceWindow | undefined {
  if (isWorkspaceWindow(value)) return JSON.parse(JSON.stringify(value)) as WorkspaceWindow;
  if (Value.Check(PreviousWorkspaceWindow, value)) {
    const migrated = { ...JSON.parse(JSON.stringify(value)) as Static<typeof PreviousWorkspaceWindow>, schemaVersion: 3 as const };
    return isWorkspaceWindow(migrated) ? migrated : undefined;
  }
  if (!Value.Check(LegacyWorkspaceWindow, value)) return;
  const legacy = value as Static<typeof LegacyWorkspaceWindow>;
  if (legacy.views.filter(view => view.placement === 'primary').length !== 1 || legacy.views[0]?.id !== legacy.primaryViewId
    || legacy.mainMinimized && !legacy.views.some(view => view.placement === 'dock')) return;
  const { primaryViewId, mainMinimized, ...rest } = JSON.parse(JSON.stringify(legacy)) as Static<typeof LegacyWorkspaceWindow>;
  const migrated = { ...rest, schemaVersion: 3 as const, selectedPrimaryViewId: primaryViewId,
    views: rest.views.map(view => view.id === primaryViewId ? { ...view, collapsed: mainMinimized || view.collapsed } : view) };
  return isWorkspaceWindow(migrated) ? migrated : undefined;
}
