import { expect, it } from 'vitest';
import { TrackedSessionViews } from './tracked-session-views.js';
import { createCompositionDocument, createCompositionSlot, parseComposition } from './session-composition-model.js';

function fixture() {
  const slots = ['parent', 'child', 'side', 'nested'].map(id => createCompositionSlot(id,
    { hostId: 'host', providerId: 'codex', nativeSessionId: id, title: id }, 'scope'));
  const document = createCompositionDocument('scope', slots);
  document.tracks = [{ entryId: 'track-parent', slotId: 'parent' }, { entryId: 'track-child', slotId: 'child' }];
  const views = new TrackedSessionViews(document, () => {});
  return { document, views };
}

it('remembers the explicit track even when its visible primary is another member', () => {
  const { views } = fixture();
  views.select('track-parent'); views.remember({ primarySlot: 'child', selections: {}, focus: 'child' });
  views.select('track-child'); views.remember({ primarySlot: 'parent', selections: {}, focus: 'parent' });
  expect(views.get('track-parent')).toMatchObject({ primarySlot: 'child', focus: 'child' });
  expect(views.get('track-child')).toMatchObject({ primarySlot: 'parent', focus: 'parent' });
});

it('does not invent a track owner from a native session or family', () => {
  const { views, document } = fixture();
  views.remember({ primarySlot: 'child', selections: {} });
  expect(document.tracks.every(track => track.view === undefined)).toBe(true);
});

it('drops a removed track layout without deleting the view or its data owners', () => {
  const { views, document } = fixture();
  const owners = structuredClone(document.slots[0]!.owners);
  views.select('track-parent'); views.remember({ primarySlot: 'side', selections: {} });
  views.retain(['track-child']); views.bind('track-parent', 'parent');
  expect(views.get('track-parent')).toBeUndefined();
  expect(document.slots[0]!.owners).toEqual(owners);
});

it('unlinks a side in every remembered layout while retaining its independent path', () => {
  const { views } = fixture();
  views.remember({ primarySlot: 'parent', selections: { parent: 'side', side: 'nested' }, focus: 'nested', anchor: 'nested' }, 'track-parent');
  views.remember({ primarySlot: 'side', selections: { side: 'nested' }, focus: 'nested' }, 'track-child');
  views.unlink('parent', 'side');
  expect(views.get('track-parent')).toMatchObject({ selections: { parent: null, side: 'nested' }, focus: 'parent', anchor: 'parent' });
  expect(views.get('track-child')).toMatchObject({ selections: { side: 'nested' }, focus: 'nested' });
});

it('restores Track memory from the same document as its view bindings', () => {
  const { views, document } = fixture();
  views.select('track-parent'); views.remember({ primarySlot: 'child', selections: {}, focus: 'child' });
  const saved = parseComposition(JSON.parse(JSON.stringify(document)), 'scope');
  const restored = new TrackedSessionViews(saved, () => {});
  expect(restored.get('track-parent')).toEqual(views.get('track-parent'));
  expect(saved.selectedTrack).toBe('track-parent');
});

it('keeps two independent views of one native session through a role replacement', () => {
  const { views, document } = fixture();
  document.slots[0]!.intent = { kind: 'fixed', target: document.slots[1]!.intent.target };
  views.remember({ primarySlot: 'parent', selections: {}, focus: 'parent' }, 'track-parent');
  views.remember({ primarySlot: 'child', selections: {}, focus: 'child' }, 'track-child');
  expect(views.get('track-parent')?.primary.nativeSessionId).toBe('child');
  expect(views.get('track-child')?.primary.nativeSessionId).toBe('child');
  document.slots[0]!.intent = { kind: 'fixed', target: { hostId: 'host', native: { providerId: 'codex', nativeSessionId: 'next' } } };
  expect(views.get('track-parent')?.primary.nativeSessionId).toBe('next');
  expect(views.get('track-child')?.primary.nativeSessionId).toBe('child');
});

it('rejects unknown view references instead of falling back to a native match', () => {
  const { views } = fixture();
  expect(() => views.bind('invalid', 'missing')).toThrow('Tracked view is unavailable.');
  expect(() => views.select('invalid')).toThrow('Tracked view is unavailable.');
  expect(() => views.remember({ primarySlot: 'missing', selections: {} }, 'track-parent')).toThrow('unavailable view');
});

it('retains the independent layout when the outer Track list deduplicates a successor', () => {
  const { views, document } = fixture();
  document.retained.push({ slot: 'child', against: 'parent' });
  views.remember({ primarySlot: 'parent', selections: {}, focus: 'parent' }, 'track-parent');
  views.select('track-child');
  views.remember({ primarySlot: 'child', selections: { child: 'nested' }, focus: 'nested' });
  views.retain(['track-parent']);
  expect(document.selectedTrack).toBe('track-child');
  expect(views.get('track-child')).toMatchObject({ primarySlot: 'child', selections: { child: 'nested' }, focus: 'nested' });
  expect(views.getForSlot('child')).toEqual(views.get('track-child'));
  views.remember({ primarySlot: 'child', selections: {}, focus: 'child' });
  expect(views.getForSlot('parent')).toMatchObject({ primarySlot: 'parent', selections: {}, focus: 'parent' });
});
