// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { localEdges, mergeSides, openSideKeys, rekeySelections, sameEdges, selectedEdges, selectionSteps, sharedFamilySides, swapKey } from './side-layout.js';

describe('the selection of the document', () => {
  it('maps a source to the target of its selected edge and ignores edges that are not selected', () => {
    expect(selectedEdges([{ source: 'a', target: 'b', selected: true }, { source: 'a', target: 'c', selected: false }, { source: 'b', target: 'd', selected: true }]))
      .toEqual({ a: 'b', b: 'd' });
  });
  it('is empty without edges', () => expect(selectedEdges([])).toEqual({}));
});

describe('merging stored Sides with the projected layout', () => {
  const key = (side: { id: string }) => side.id;
  it('keeps the stored Sides the layout does not name, in order, before the projected ones', () => {
    expect(mergeSides([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'b' }, { id: 'x' }], key).map(key)).toEqual(['a', 'c', 'b', 'x']);
  });
  it('lists a Side the layout names once', () => {
    expect(mergeSides([{ id: 'a' }], [{ id: 'a' }], key).map(key)).toEqual(['a']);
  });
  it('is the stored list without a projected layout', () => {
    const stored = [{ id: 'a' }];
    expect(mergeSides(stored, undefined, key)).toBe(stored);
  });
});

describe('the Sides of a shared family', () => {
  type Session = { id: string; viewId?: string };
  const views = [
    { id: 'v1', attachedTo: 'root', binding: 's1' },
    { id: 'v2', attachedTo: 'root', binding: 's2' },
    { id: 'v3', binding: 's3' },
    { id: 'v4', attachedTo: 'root' },
  ];
  const facts = (overrides: Partial<Parameters<typeof sharedFamilySides<Session, { id: string }, string>>[1]> = {}) => ({
    inFamily: () => true, slotOf: (viewId: string) => ({ id: `slot-${viewId}` }), known: () => undefined, mounted: () => undefined,
    sessionOfSlot: (slot: { id: string }) => ({ id: slot.id.replace('slot-v', 's') }), sessionKey: (session: Session) => session.id, bindingKey: (binding: string) => binding,
    ...overrides,
  });
  it('lists the attached views of the family whose session matches their binding', () => {
    expect(sharedFamilySides<Session, { id: string }, string>(views, facts()).map(session => session.id)).toEqual(['s1', 's2']);
  });
  it('skips a view outside the family', () => {
    expect(sharedFamilySides<Session, { id: string }, string>(views, facts({ inFamily: viewId => viewId === 'v2' })).map(session => session.id)).toEqual(['s2']);
  });
  it('skips a view that is not attached, and one without a binding', () => {
    expect(sharedFamilySides<Session, { id: string }, string>([views[2]!, views[3]!], facts())).toEqual([]);
  });
  it('skips a view whose slot resolves to another session than its binding', () => {
    expect(sharedFamilySides<Session, { id: string }, string>(views, facts({ sessionOfSlot: () => ({ id: 'other' }) }))).toEqual([]);
  });
  it('prefers the known session of the slot to the mounted one and to the composition', () => {
    const known: Session = { id: 's1', viewId: 'known' };
    const result = sharedFamilySides<Session, { id: string }, string>([views[0]!], facts({ known: () => known, mounted: () => ({ id: 's1', viewId: 'slot-v1' }) }));
    expect(result).toEqual([known]);
  });
  it('uses the mounted session only while it still names the slot', () => {
    const mounted: Session = { id: 's1', viewId: 'slot-v1' };
    expect(sharedFamilySides<Session, { id: string }, string>([views[0]!], facts({ mounted: () => mounted }))).toEqual([mounted]);
    const stale: Session = { id: 's1', viewId: 'another-slot' };
    expect(sharedFamilySides<Session, { id: string }, string>([views[0]!], facts({ mounted: () => stale }))[0]).not.toBe(stale);
  });
  it('does not read the binding of a view that has none', () => {
    const unbound = [{ id: 'v4', attachedTo: 'root' }];
    expect(sharedFamilySides<Session, { id: string }, string>(unbound, facts({ bindingKey: binding => { if (binding === undefined) throw new Error('read an absent binding'); return binding; } }))).toEqual([]);
  });
  it('skips a view whose slot is not known', () => {
    expect(sharedFamilySides<Session, { id: string }, string>(views, facts({ slotOf: () => undefined }))).toEqual([]);
  });
});

describe('the Sides shown beside a source', () => {
  it('lists every view attached to the source in a shared Window', () => {
    expect(openSideKeys('slot', { shared: true, attachedKeys: () => ['k1', 'k2'], selectedKey: () => 'unused' })).toEqual(['k1', 'k2']);
  });
  it('lists only the selected Side otherwise', () => {
    expect(openSideKeys('slot', { shared: false, attachedKeys: () => ['unused'], selectedKey: () => 'k3' })).toEqual(['k3']);
  });
  it('lists nothing when no Side is selected', () => {
    expect(openSideKeys('slot', { shared: false, attachedKeys: () => [], selectedKey: () => undefined })).toEqual([]);
  });
});

describe('what a change of selection means for a shared Window', () => {
  const facts = (overrides: Partial<Parameters<typeof selectionSteps>[2]> = {}) => ({
    sourceView: (sourceId: string) => sourceId === 'unknown' ? undefined : { id: `view-${sourceId}` },
    viewOfSlot: (slotId: string) => slotId === 'attached' ? { id: 'view-attached', attachedTo: 'view-src' } : slotId === 'elsewhere' ? { id: 'view-elsewhere', attachedTo: 'view-other' } : undefined,
    slotExists: (slotId: string) => slotId !== 'ghost', slotOwned: (slotId: string) => slotId === 'owned',
    ...overrides,
  });
  it('does nothing for a target that did not change', () => {
    expect(selectionSteps({ src: 'attached' }, { src: 'attached' }, facts())).toEqual([]);
  });
  it('does nothing for a source the Window does not know', () => {
    expect(selectionSteps({}, { unknown: 'attached' }, facts())).toEqual([]);
  });
  it('selects the view already attached to the source', () => {
    expect(selectionSteps({}, { src: 'attached' }, facts())).toEqual([{ type: 'select', viewId: 'view-attached' }]);
  });
  it('attaches a target that exists, and says whether the Window owns its slot', () => {
    expect(selectionSteps({}, { src: 'fresh' }, facts())).toEqual([{ type: 'attach', sourceViewId: 'view-src', slotId: 'fresh', owned: false }]);
    expect(selectionSteps({}, { src: 'owned' }, facts())).toEqual([{ type: 'attach', sourceViewId: 'view-src', slotId: 'owned', owned: true }]);
  });
  it('attaches a slot whose view is attached to another source instead of selecting that view', () => {
    expect(selectionSteps({}, { src: 'elsewhere' }, facts())).toEqual([{ type: 'attach', sourceViewId: 'view-src', slotId: 'elsewhere', owned: false }]);
  });
  it('selects the source itself when the target is cleared or its slot is gone', () => {
    expect(selectionSteps({ src: 'attached' }, { src: null }, facts())).toEqual([{ type: 'select', viewId: 'view-src' }]);
    expect(selectionSteps({}, { src: 'ghost' }, facts())).toEqual([{ type: 'select', viewId: 'view-src' }]);
  });
  it('selects the source when the slot is gone, even if another source still shows a view of it', () => {
    expect(selectionSteps({}, { src: 'elsewhere' }, facts({ slotExists: () => false }))).toEqual([{ type: 'select', viewId: 'view-src' }]);
  });
  it('keeps the order of the sources', () => {
    expect(selectionSteps({}, { a: null, src: 'attached' }, facts()).map(step => step.type === 'select' ? step.viewId : step.slotId)).toEqual(['view-a', 'view-attached']);
  });
});

describe('the edges of a local document', () => {
  it('has one selected edge per source with a target and none for a cleared one', () => {
    expect(localEdges({ a: 'b', c: null, d: 'e' })).toEqual([{ source: 'a', target: 'b', selected: true }, { source: 'd', target: 'e', selected: true }]);
  });
  it('compares edge lists by value, in order', () => {
    const edge = { source: 'a', target: 'b', selected: true };
    expect(sameEdges([edge], [{ ...edge }])).toBe(true);
    expect(sameEdges([edge], [{ ...edge, selected: false }])).toBe(false);
    expect(sameEdges([edge, { source: 'c', target: 'd', selected: true }], [{ source: 'c', target: 'd', selected: true }, edge])).toBe(false);
  });
});

describe('following a Side whose session was replaced', () => {
  it('renames the key in a selection map, in keys that hold it as a value only, and keeps cleared selections', () => {
    expect(rekeySelections({ a: 'old', b: 'other', c: null, old: 'z' }, 'old', 'new')).toEqual({ a: 'new', b: 'other', c: null, old: 'z' });
  });
  it('swaps a single record only when it held the old key', () => {
    expect(swapKey('old', 'old', 'new')).toBe('new');
    expect(swapKey('x', 'old', 'new')).toBe('x');
    expect(swapKey(undefined, 'old', 'new')).toBeUndefined();
  });
});
