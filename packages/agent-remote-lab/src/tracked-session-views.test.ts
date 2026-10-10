import { expect, it } from 'vitest';
import { TrackedSessionViews, type TrackedSessionView } from './tracked-session-views.js';
import type { SessionEntry } from './session-tree.js';
import { sessionKey } from './session-tree.js';

const parent: SessionEntry = { hostId: 'host-a', providerId: 'codex', nativeSessionId: 'parent', title: 'Project' };
const child: SessionEntry = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent', title: 'Review' };
const view = (primary: SessionEntry): TrackedSessionView => ({ primary, selections: {} });

it('keeps separately tracked members of the same family independent', () => {
  const views = new TrackedSessionViews();
  const tracked = [parent, child];
  views.select(parent);
  views.remember(view(child), tracked, tracked);
  views.select(child);
  views.remember(view(parent), tracked, tracked);
  expect(views.get(parent)?.primary.nativeSessionId).toBe('child');
  expect(views.get(child)?.primary.nativeSessionId).toBe('parent');
});

it('does not overwrite the previous track when another Host opens the same native ID', () => {
  const other = { ...parent, hostId: 'host-b' };
  const views = new TrackedSessionViews();
  const tracked = [parent, other];
  views.select(parent);
  views.remember(view(child), tracked, [parent, child, other]);
  views.remember(view(other), tracked, [parent, child, other]);
  expect(views.get(parent)?.primary.nativeSessionId).toBe('child');
  expect(views.get(other)?.primary.hostId).toBe('host-b');
});

it('associates a directly opened descendant with its nearest tracked ancestor', () => {
  const nested = { ...child, nativeSessionId: 'nested', parentNativeSessionId: 'child' };
  const views = new TrackedSessionViews();
  views.remember(view(nested), [parent], [parent, child, nested]);
  expect(views.get(parent)?.primary.nativeSessionId).toBe('nested');
});

it('drops view memory when a session is untracked instead of reviving it when tracked again', () => {
  const views = new TrackedSessionViews();
  views.select(parent);
  views.remember(view(child), [parent], [parent, child]);
  views.retain([]);
  views.retain([parent]);
  expect(views.get(parent)).toBeUndefined();
});

it('removes an unlinked side from every saved track without breaking its own descendants', () => {
  const side = { ...parent, nativeSessionId: 'side', title: 'Side' };
  const nested = { ...parent, nativeSessionId: 'nested', title: 'Nested' };
  const [a, b, c] = [parent, side, nested].map(sessionKey);
  const views = new TrackedSessionViews();
  const tracked = [parent, side];
  views.select(parent);
  views.remember({ primary: parent, selections: { [a!]: b!, [b!]: c! }, focus: c, anchor: c }, tracked, tracked);
  views.select(side);
  views.remember({ primary: side, selections: { [b!]: c! }, focus: c, anchor: c }, tracked, tracked);
  views.unlink(parent, side);
  expect(views.get(parent)).toEqual({ primary: parent, selections: { [a!]: null, [b!]: c! }, focus: a, anchor: a });
  expect(views.get(side)).toEqual({ primary: side, selections: { [b!]: c! }, focus: c, anchor: c });
});

it('keeps a different selected sibling when another side is unlinked', () => {
  const side = { ...parent, nativeSessionId: 'side' };
  const a = sessionKey(parent), b = sessionKey(side), other = 'other-side';
  const views = new TrackedSessionViews();
  const saved = { primary: parent, selections: { [a]: other, [b]: 'nested' }, focus: other, anchor: other };
  views.remember(saved, [parent], [parent]);
  views.unlink(parent, side);
  expect(views.get(parent)).toEqual(saved);
});

it('retains stable track snapshots and rejects a restore over a newer same-tab selection', () => {
  const views = new TrackedSessionViews();
  views.select(parent); views.remember(view(child), [parent], [parent, child]);
  const before = views.snapshot();
  views.select(child);
  expect(views.restore(before, before.editRevision)).toBe(false);
  expect(views.snapshot().selected).toBe(sessionKey(child));
  const fresh = new TrackedSessionViews();
  expect(fresh.restore(before, 0)).toBe(true);
  expect(fresh.get(parent)?.primary.nativeSessionId).toBe('child');
  before.views[0]!.view.primary.title = 'External mutation';
  expect(fresh.get(parent)?.primary.title).toBe('Review');
});
it('keeps stable view owners through remember and retain after a native replacement', () => {
  const views = new TrackedSessionViews();
  const a = { hostId: 'host', providerId: 'codex', nativeSessionId: 'A', agentId: 'runtime-A', title: 'A' };
  const b = { ...a, nativeSessionId: 'B', agentId: 'runtime-B', title: 'B' };
  views.remember({ primary: a, selections: {} }, [a], [a]); views.bindOwner(a, 'entry-A');
  views.bindOwner(b, 'entry-A'); views.select(b, 'entry-A');
  views.remember({ primary: b, selections: {}, focus: sessionKey(b) }, [b], [b]);
  views.retain([b]);
  expect(views.getByOwner('entry-A')).toMatchObject({ primary: b, focus: sessionKey(b) });
  expect(views.get(b)).toEqual(views.getByOwner('entry-A'));
  expect(views.snapshot().selected).toBe('entry-A');
});

it('restores the parent owner when a remembered mobile child is the primary view', () => {
  const parent = { hostId: 'host', providerId: 'codex', nativeSessionId: 'parent', title: 'Parent' };
  const child = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent' };
  const views = new TrackedSessionViews();
  views.bindOwner(parent, 'stable-parent'); views.select(parent);
  views.remember({ primary: child, selections: {}, focus: sessionKey(child) }, [parent], [parent, child]);
  const restored = new TrackedSessionViews();
  expect(restored.restore(views.snapshot(), 0)).toBe(true);
  expect(restored.get(parent)?.primary).toEqual(child);
  restored.retain([parent]);
  expect(restored.getByOwner('stable-parent')?.focus).toBe(sessionKey(child));
});

it('removes a projected self-link while retaining the duplicate view and its independent descendants', () => {
  const a = { ...parent, nativeSessionId: 'A' }, b = { ...parent, nativeSessionId: 'B' }, c = { ...parent, nativeSessionId: 'C' };
  const views = new TrackedSessionViews(); views.select(a);
  views.remember({ primary: a, selections: { [sessionKey(a)]: sessionKey(b), [sessionKey(b)]: sessionKey(c) }, focus: sessionKey(c) }, [a, b], [a, b, c]);
  views.select(b); views.remember({ primary: b, selections: { [sessionKey(b)]: sessionKey(c) }, focus: sessionKey(c) }, [a, b], [a, b, c]);
  views.projectOwner(a, b, 'stable-A');
  expect(views.getByOwner('stable-A')?.selections[sessionKey(b)]).toBeNull();
  expect(views.getByOwner('stable-A')?.focus).toBe(sessionKey(b));
  expect(views.getByOwner(sessionKey(b))?.selections[sessionKey(b)]).toBe(sessionKey(c));
});
