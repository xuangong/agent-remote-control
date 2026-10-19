import { expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, compositionRoleKey, createCompositionSlot, createAskOwner, parseComposition, type RoleCheckpoint } from './session-composition.js';
import { ensureWindowCompositionSlot, projectWindowComposition, primaryWindowFamily, adoptWindowPrimaryRole, bindWindowCompositionSlot, createWindowSessionBridge, resolveCompositionWindowViewId } from './window-composition.js';
import { createWindowFeature } from './window-feature-views.js';
const binding = { hostId: 'mac', providerId: 'codex', nativeSessionId: 's1', title: 'Project' };
it('projects each selected primary family without losing another group owners', () => {
  const doc = createCompositionDocument('scope');
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 1, title: 'Project', selectedPrimaryViewId: 'a', selectedViewId: 'a-child',
    views: [createWindowView('a', binding, 'primary'), { ...createWindowView('a-child', { ...binding, nativeSessionId: 'child-a' }, 'attached'), attachedTo: 'a' },
      createWindowView('b', binding, 'primary'), { ...createWindowView('b-child', { ...binding, nativeSessionId: 'child-b' }, 'attached'), attachedTo: 'b' }] };
  projectWindowComposition(doc, window);
  const a = doc.primary!, aChild = doc.focus!, aOwner = doc.asks.find(owner => owner.sourceSlot === a)!;
  expect(aOwner).toBeDefined();
  aOwner.records = [{ id: 'ask-a' }];
  projectWindowComposition(doc, { ...window, selectedPrimaryViewId: 'b', selectedViewId: 'b-child' });
  const b = doc.primary!, bChild = doc.focus!;
  expect(b).not.toBe(a); expect(bChild).not.toBe(aChild);
  expect(doc.edges).toEqual([{ source: b, target: bChild, selected: true }]);
  expect(doc.slots).toHaveLength(4); expect(doc.asks.find(owner => owner.sourceSlot === a)).toBe(aOwner);
  projectWindowComposition(doc, window);
  expect(doc.primary).toBe(a); expect(doc.focus).toBe(aChild);
  expect(doc.edges).toEqual([{ source: a, target: aChild, selected: true }]);
  expect(doc.asks.find(owner => owner.sourceSlot === a)?.records).toEqual([{ id: 'ask-a' }]);
});
it('keeps runtime slots and draft owners distinct for two views of the same session', () => {
  const doc = createCompositionDocument('scope');
  const a = ensureWindowCompositionSlot(doc, 'w', 'a', binding), b = ensureWindowCompositionSlot(doc, 'w', 'b', binding);
  expect(a.id).not.toBe(b.id); expect(a.owners.text.key).not.toBe(b.owners.text.key);
  expect(ensureWindowCompositionSlot(doc, 'w', 'a', binding)).toBe(a);
});
it('restores separate concrete history and current-role owners for the same Window view', () => {
  const doc = createCompositionDocument('scope');
  const current = ensureWindowCompositionSlot(doc, 'w', 'a', binding);
  const historyBinding = { ...binding, sessionIntent: 'history' as const };
  const history = ensureWindowCompositionSlot(doc, 'w', 'a', historyBinding);
  expect(history.id).not.toBe(current.id);
  expect(history.intent.kind).toBe('history');
  expect(history.origin.kind).toBe('history');
  expect(history.owners).not.toEqual(current.owners);
  expect(() => bindWindowCompositionSlot(doc, 'w', 'a', historyBinding, current.id)).toThrow(/does not match/);
  const restored = parseComposition(JSON.parse(JSON.stringify(doc)), doc.scope);
  expect(ensureWindowCompositionSlot(restored, 'w', 'a', historyBinding).id).toBe(history.id);
  expect(ensureWindowCompositionSlot(restored, 'w', 'a', binding).id).toBe(current.id);
});
it('projects remote primary families without changing the Window and drops closed local edges', () => {
  const doc = createCompositionDocument('scope');
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 1, title: 'Project', selectedPrimaryViewId: 'main', selectedViewId: 'child',
    views: [createWindowView('main', binding, 'primary'), { ...createWindowView('child', { ...binding, nativeSessionId: 's2' }, 'attached'), attachedTo: 'main' }, createWindowView('dock', binding)] };
  const before = JSON.stringify(window);
  expect(projectWindowComposition(doc, window)).toBe(true); expect(doc.edges).toHaveLength(1);
  expect(doc.focus).toBe(doc.edges[0]?.target); expect(JSON.stringify(window)).toBe(before);
  expect(projectWindowComposition(doc, window)).toBe(false);
  projectWindowComposition(doc, { ...window, views: [window.views[0]!, window.views[2]!], selectedViewId: 'dock' });
  expect(doc.edges).toEqual([]); expect(doc.focus).toBe(doc.primary);
});
it('does not alias colon-containing Window and View identity tuples', () => {
  const doc = createCompositionDocument('scope');
  const a = ensureWindowCompositionSlot(doc, 'w:a', 'b', binding);
  const b = ensureWindowCompositionSlot(doc, 'w', 'a:b', binding);
  expect(a.id).not.toBe(b.id); expect(a.owners.text).not.toEqual(b.owners.text);
});

it('preserves an enrolled native role while allocating independent Window view owners', () => {
  const doc = createCompositionDocument('scope');
  const native = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 's1' };
  const progress = { revision: 2, status: 'applied' as const, retention: 'page' as const };
  const checkpoint: RoleCheckpoint = { scope: 'scope', hostId: 'mac', controllerId: 'controller', roleId: 'role', appliedRevision: 2,
    desired: { operationId: 'handoff', expectedRevision: 1, committedRevision: 2, from: { ...native, nativeSessionId: 'origin' }, to: native,
      projectionDigest: { version: 1, algorithm: 'sha256', hex: 'a'.repeat(64) } },
    documents: { composition: progress, track: progress, ask: progress, draftViews: progress } };
  doc.roles.push(checkpoint);
  const enrolled = createCompositionSlot('native', binding, 'scope');
  enrolled.intent = { kind: 'role', roleKey: compositionRoleKey(checkpoint), revision: 2, target: { hostId: 'mac', native } };
  doc.slots.push(enrolled);
  const view = ensureWindowCompositionSlot(doc, 'w', 'main', binding);
  expect(view.intent).toEqual(enrolled.intent);
  expect(view.intent).not.toBe(enrolled.intent);
  expect(view.owners.text).not.toEqual(enrolled.owners.text);
  expect(ensureWindowCompositionSlot(doc, 'other', 'main', binding).id).not.toBe(view.id);
});
it('does not promote a self-reported Window role binding to native role authority', () => {
  const doc = createCompositionDocument('scope');
  const view = ensureWindowCompositionSlot(doc, 'w', 'main', { ...binding, role: { controllerId: 'fake', roleId: 'fake', revision: 10 } });
  expect(view.intent.kind).toBe('fixed');
});

it.each([false, true])('clears an empty primary presentation while retaining native slots and draft owners (no panes: %s)', noPanes => {
  const doc = createCompositionDocument('scope');
  const slot = ensureWindowCompositionSlot(doc, 'w', 'main', binding);
  doc.primary = slot.id; doc.address = slot.id; doc.focus = slot.id; doc.anchor = slot.id; doc.collapsed = [slot.id];
  const before = structuredClone(slot);
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'empty', revision: 0, title: 'Empty', selectedPrimaryViewId: noPanes ? null : 'main', selectedViewId: noPanes ? null : 'main', views: noPanes ? [] : [createWindowView('main', undefined, 'primary')] };
  expect(projectWindowComposition(doc, window)).toBe(true);
  expect(doc.primary).toBeUndefined(); expect(doc.focus).toBeUndefined(); expect(doc.collapsed).toEqual([]);
  expect(doc.slots.find(item => item.id === slot.id)).toEqual(before);
  expect(primaryWindowFamily(window)).toEqual(new Set(noPanes ? [] : ['main']));
  expect(projectWindowComposition(doc, window)).toBe(false);
});

it('maps a verified primary directly without changing native, retained, or Ask owner identities', () => {
  const doc = createCompositionDocument('scope');
  const native = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });
  const progress = { revision: 3, status: 'applied' as const, retention: 'page' as const };
  const checkpoint: RoleCheckpoint = { scope: 'scope', hostId: 'mac', controllerId: 'controller', roleId: 'role', appliedRevision: 3,
    desired: { operationId: 'handoff', expectedRevision: 2, committedRevision: 3, from: native('s2'), to: native('s3'), projectionDigest: { version: 1, algorithm: 'sha256', hex: 'a'.repeat(64) } },
    documents: { composition: progress, track: progress, ask: progress, draftViews: progress } };
  doc.roles.push(checkpoint);
  const source = createCompositionSlot('native', binding, 'scope'); source.intent = { kind: 'role', roleKey: compositionRoleKey(checkpoint), revision: 3, target: { hostId: 'mac', native: native('s3') } };
  doc.slots.push(source, createCompositionSlot('retained-B', { ...binding, nativeSessionId: 's2' }, 'scope')); doc.primary = source.id;
  doc.retained.push({ slot: 'retained-B', against: source.id });
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', { ...binding, nativeSessionId: 's2' }, 'primary')] };
  doc.asks.push(createAskOwner(source, doc.scope));
  const original = structuredClone({ source, retained: doc.retained, asks: doc.asks });
  const slot = adoptWindowPrimaryRole(doc, window)!;
  expect(slot.intent).toEqual(source.intent); expect(slot.owners).toEqual(source.owners); expect(slot).toBe(source);
  expect(ensureWindowCompositionSlot(doc, window.id, 'main', window.views[0]!.binding!)).toBe(slot);
  expect(doc.slots.filter(candidate => candidate.id === slot.id)).toHaveLength(1);
  expect(doc.retained).toEqual([{ slot: 'retained-B', against: slot.id }]);
  expect({ source, retained: doc.retained, asks: doc.asks }).toEqual(original);
  expect(adoptWindowPrimaryRole(doc, { ...window, id: 'other' })).toBeUndefined();
  const second = ensureWindowCompositionSlot(doc, 'other', 'main', window.views[0]!.binding!);
  expect(second.owners.text).not.toEqual(source.owners.text);
  expect(adoptWindowPrimaryRole(doc, { ...window, views: [createWindowView('main', { ...binding, nativeSessionId: 'unrelated' }, 'primary')] })).toBeUndefined();
});

it('adopts one unassigned local session owner from the Window binding without a legacy active selection', () => {
  const document = createCompositionDocument('scope');
  const source = createCompositionSlot('legacy-session', binding, document.scope);
  const ask = { ...createAskOwner(source, document.scope), records: [{ id: 'existing-ask', target: '["mac","codex","ask"]' }] };
  document.slots.push(source); document.asks.push(ask);
  const before = structuredClone({ source, ask });
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary')] };
  expect(document.primary).toBeUndefined();
  expect(adoptWindowPrimaryRole(document, window)).toBe(source);
  expect(ensureWindowCompositionSlot(document, 'w', 'main', binding)).toBe(source);
  expect({ source, ask }).toEqual(before);
  expect(document.primary).toBeUndefined();
  expect(adoptWindowPrimaryRole(document, { ...window, id: 'another' })).toBeUndefined();
  expect(ensureWindowCompositionSlot(document, 'another', 'main', binding).owners).not.toEqual(source.owners);
});

it('leaves ambiguous unassigned owners untouched when adopting a Window binding', () => {
  const document = createCompositionDocument('scope');
  document.slots.push(createCompositionSlot('first', binding, document.scope), createCompositionSlot('second', binding, document.scope));
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary')] };
  const before = JSON.stringify(document);
  expect(adoptWindowPrimaryRole(document, window)).toBeUndefined();
  expect(JSON.stringify(document)).toBe(before);
});

it.each([false, true])('keeps a Window owner ahead of an unassigned matching legacy owner (mapping retained: %s)', retainMapping => {
  const document = createCompositionDocument('scope');
  const source = ensureWindowCompositionSlot(document, 'w', 'main', binding);
  const legacy = createCompositionSlot('legacy-session', binding, document.scope);
  document.slots.push(legacy); document.asks.push(createAskOwner(legacy, document.scope));
  if (!retainMapping) delete document.windowBindings;
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary')] };
  adoptWindowPrimaryRole(document, window);
  expect(ensureWindowCompositionSlot(document, 'w', 'main', binding)).toBe(source);
  expect(source.owners).not.toEqual(legacy.owners);
});

it('resolves application owners through the session bridge without changing layout authority', () => {
  const doc = createCompositionDocument('scope');
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'bridge', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary')] };
  const bridge = createWindowSessionBridge(doc, window);
  const slot = bridge.slotForView('main')!;
  expect(bridge.slotForView('main')).toBe(slot);
  expect(resolveCompositionWindowViewId(doc, window, slot.owners.display.key)).toBe('main');
  expect(bridge.slotForView('missing')).toBeUndefined();
  window.views.push({ ...createWindowView('ask'), feature: { kind: 'ask', id: doc.asks[0]!.id }, closeWith: 'main' });
  expect(resolveCompositionWindowViewId(doc, window, `ask:${doc.asks[0]!.geometryScope}`)).toBe('ask');
  expect(slot.owners.text.key).toBe(doc.slots[0]!.owners.text.key);
});

it('resolves an Ask when its owner and source slot share an identity', () => {
  const document = createCompositionDocument('scope');
  const source = createCompositionSlot('shared-owner', binding, document.scope);
  const owner = { ...createAskOwner(source, document.scope), id: source.id };
  document.slots.push(source); document.asks.push(owner);
  bindWindowCompositionSlot(document, 'w', 'main', binding, source.id);
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary'),
      { ...createWindowView('ask'), feature: createWindowFeature({ kind: 'ask', id: 'shared-ask', source: binding }), closeWith: 'main' }] };
  const restored = parseComposition(JSON.parse(JSON.stringify(document)), document.scope);
  expect(resolveCompositionWindowViewId(restored, window, `ask:${owner.geometryScope}`)).toBe('ask');
});

it('persists mapping, rejects cross-view ownership, and restores independent A-B-A owners', () => {
  const doc = createCompositionDocument('scope');
  const source = createCompositionSlot('legacy', binding, doc.scope);
  doc.slots.push(source); doc.asks.push(createAskOwner(source, doc.scope));
  bindWindowCompositionSlot(doc, 'w', 'main', binding, source.id);
  const other = ensureWindowCompositionSlot(doc, 'w', 'main', { ...binding, nativeSessionId: 's2' });
  expect(other.owners).not.toEqual(source.owners);
  const restored = parseComposition(JSON.parse(JSON.stringify(doc)), doc.scope);
  expect(ensureWindowCompositionSlot(restored, 'w', 'main', binding).id).toBe(source.id);
  expect(ensureWindowCompositionSlot(restored, 'w', 'main', { ...binding, nativeSessionId: 's2' }).id).toBe(other.id);
  expect(() => bindWindowCompositionSlot(restored, 'another', 'main', binding, source.id)).toThrow(/another Window view/);
  expect(() => bindWindowCompositionSlot(restored, 'w', 'copy', binding, source.id)).toThrow(/another Window view/);
  expect(restored.asks.find(owner => owner.sourceSlot === source.id)?.id).toBe(doc.asks[0]!.id);
});
it('rejects corrupt persisted binding maps before they can select native owners', () => {
  const doc = createCompositionDocument('scope');
  const slot = ensureWindowCompositionSlot(doc, 'w', 'main', binding);
  const entry = doc.windowBindings![0]!;
  for (const windowBindings of [
    [{ ...entry, slotId: 'missing' }],
    [{ ...entry, bindingKey: 'not-json' }],
    [{ ...entry, bindingKey: JSON.stringify(['host', 'provider']) }],
    [{ ...entry, bindingKey: JSON.stringify(['host', 'provider', 'native', 'current']) }],
    [entry, { ...entry }],
    [entry, { ...entry, viewId: 'copy' }],
  ]) expect(() => parseComposition({ ...doc, windowBindings }, doc.scope)).toThrow();
  expect(doc.slots[0]).toBe(slot);
});

it('fails at binding capacity without creating partial native slots or Ask owners', () => {
  const doc = createCompositionDocument('scope');
  const slot = ensureWindowCompositionSlot(doc, 'w', 'main', binding);
  doc.windowBindings = Array.from({ length: 4096 }, (_, index) => ({ windowId: 'w', viewId: 'main', bindingKey: JSON.stringify(['mac', 'codex', `s${index}`]), slotId: slot.id }));
  const before = JSON.stringify(doc);
  expect(() => ensureWindowCompositionSlot(doc, 'new', 'main', binding)).toThrow(/capacity/);
  expect(JSON.stringify(doc)).toBe(before);
});

it('retains a source reference for an open Ask after a fresh page sees a different main binding', async () => {
  const { createWindowFeature } = await import('./window-feature-views.js');
  const { windowCompositionMapping, windowAskSourceMatches } = await import('./window-composition.js');
  const source = { ...binding, agentId: 'source-agent' };
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'fresh', revision: 2, title: 'Fresh', selectedPrimaryViewId: 'main', selectedViewId: 'ask',
    views: [createWindowView('main', { ...binding, nativeSessionId: 'independent-B' }, 'primary'),
      { ...createWindowView('ask', { ...binding, nativeSessionId: 'ask-A' }, 'dock'), closeWith: 'main', feature: createWindowFeature({ kind: 'ask', id: 'shared-A', source }) }] };
  const doc = createCompositionDocument('scope');
  const unchanged = JSON.stringify(window);
  const mapping = windowCompositionMapping(doc, window);
  const references = doc.slots.filter(slot => windowAskSourceMatches(doc, slot, source));
  expect(references).toHaveLength(1);
  expect(references[0]?.metadata?.agentId).toBe('source-agent');
  expect(doc.asks.filter(owner => owner.sourceSlot === references[0]?.id)).toHaveLength(1);
  expect(mapping.get('main')?.intent.target.native.nativeSessionId).toBe('independent-B');
  expect(resolveCompositionWindowViewId(doc, window, references[0]!.id)).toBe('main');
  const owner = doc.asks.find(owner => owner.sourceSlot === references[0]!.id)!;
  expect(resolveCompositionWindowViewId(doc, window, `ask:${owner.geometryScope}`)).toBe('ask');
  const revision = doc.editRevision;
  windowCompositionMapping(doc, window);
  expect(doc.editRevision).toBe(revision);
  expect(JSON.stringify(window)).toBe(unchanged);
  expect(() => parseComposition(doc, 'scope')).not.toThrow();
});

it('keeps an Ask source through verified role succession but rejects an unrelated source', async () => {
  const { windowAskSourceAnchor, windowAskSourceMatches } = await import('./window-composition.js');
  const doc = createCompositionDocument('scope');
  const slot = createCompositionSlot('role-source', binding, 'scope');
  const native = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 's1' };
  const progress = { revision: 1, status: 'applied' as const, retention: 'page' as const };
  const checkpoint: RoleCheckpoint = { scope: 'scope', hostId: 'mac', controllerId: 'controller', roleId: 'role', appliedRevision: 1,
    desired: { operationId: 'first', expectedRevision: 0, committedRevision: 1, from: native, to: native,
      projectionDigest: { version: 1, algorithm: 'sha256', hex: 'a'.repeat(64) } },
    documents: { composition: progress, track: progress, ask: progress, draftViews: progress } };
  doc.roles.push(checkpoint); doc.slots.push(slot);
  slot.intent = { kind: 'role', roleKey: compositionRoleKey(checkpoint), revision: 1, target: { hostId: 'mac', native } };
  const anchor = windowAskSourceAnchor(doc, slot);
  expect(anchor.roleKey).toBe(compositionRoleKey(checkpoint));
  slot.intent.target.native = { ...native, nativeSessionId: 's2' }; slot.intent.revision = 2;
  checkpoint.appliedRevision = 2; checkpoint.desired.committedRevision = 2;
  expect(windowAskSourceMatches(doc, slot, anchor)).toBe(true);
  const independent = createCompositionSlot('other', { ...binding, nativeSessionId: 's2' }, 'scope');
  expect(windowAskSourceMatches(doc, independent, anchor)).toBe(false);
  const unverified = structuredClone(slot); unverified.origin = structuredClone(independent.origin);
  unverified.intent = { ...slot.intent, roleKey: 'unverified' };
  expect(windowAskSourceMatches(doc, unverified, anchor)).toBe(false);
});
it('reuses retained Window slots and owners when fresh-page mapping entries have not been restored', () => {
  const doc = createCompositionDocument('scope');
  const held = ensureWindowCompositionSlot(doc, 'w', 'ask', binding);
  const owner = doc.asks.find(owner => owner.sourceSlot === held.id)!;
  owner.records = [{ id: 'retained-ledger', target: 'saved-target' }];
  delete doc.windowBindings;
  expect(ensureWindowCompositionSlot(doc, 'w', 'ask', binding)).toBe(held);
  expect(doc.slots).toEqual([held]);
  expect(doc.asks).toEqual([owner]);
  expect(owner.records).toEqual([{ id: 'retained-ledger', target: 'saved-target' }]);
  expect(() => parseComposition(doc, 'scope')).not.toThrow();
});
