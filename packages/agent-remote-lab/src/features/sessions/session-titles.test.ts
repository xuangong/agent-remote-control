// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { confirmTitle, groupProjectionTitles, retitleSessions, titledSessions, windowProjectionTitles } from './session-titles.js';

describe('confirming a title', () => {
  it('records the title under the scope', () => {
    expect(confirmTitle(undefined, 's', 'k', 'One')).toEqual({ scope: 's', titles: new Map([['k', 'One']]) });
  });
  it('keeps the titles of the same scope and changes one', () => {
    const first = confirmTitle(undefined, 's', 'a', 'A')!;
    expect(confirmTitle(first, 's', 'b', 'B')!.titles).toEqual(new Map([['a', 'A'], ['b', 'B']]));
    expect(confirmTitle(first, 's', 'a', 'A2')!.titles).toEqual(new Map([['a', 'A2']]));
  });
  it('returns the same state for a title it already holds', () => {
    const first = confirmTitle(undefined, 's', 'a', 'A')!;
    expect(confirmTitle(first, 's', 'a', 'A')).toBe(first);
  });
  it('drops the titles of another scope', () => {
    const first = confirmTitle(undefined, 's', 'a', 'A')!;
    const next = confirmTitle(first, 't', 'b', 'B')!;
    expect(next).toEqual({ scope: 't', titles: new Map([['b', 'B']]) });
  });
  it('does not change the map it was given', () => {
    const first = confirmTitle(undefined, 's', 'a', 'A')!;
    confirmTitle(first, 's', 'b', 'B');
    expect(first.titles.size).toBe(1);
  });
});

describe('retitling listed sessions', () => {
  const key = (item: { id: string }) => item.id;
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  it('gives the named session its title and keeps the others', () => {
    expect(retitleSessions(items, key, 'b', 'B2')).toEqual([{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }]);
  });
  it('returns the same list when no listed session changes', () => {
    expect(retitleSessions(items, key, 'b', 'B')).toBe(items);
    expect(retitleSessions(items, key, 'x', 'X')).toBe(items);
  });
});

describe('the sessions whose native title is asked for', () => {
  const binding = (id: string) => ({ hostId: 'h', providerId: 'p', nativeSessionId: id, title: `t-${id}` });
  it('lists the open entries, then the sessions of the views', () => {
    expect(titledSessions(['entry'], [{ binding: binding('1') }, { binding: binding('2') }])).toEqual(['entry', binding('1'), binding('2')]);
  });
  it('skips a view without a session and a managed view', () => {
    expect(titledSessions([], [{}, { binding: binding('1'), bindingPolicy: 'managed' }, { binding: binding('2'), bindingPolicy: 'replaceable' }])).toEqual([binding('2')]);
  });
  it('keeps only the fields of the session', () => {
    expect(Object.keys(titledSessions([], [{ binding: { ...binding('1'), role: 'x' } as never }])[0] as object).sort()).toEqual(['hostId', 'nativeSessionId', 'providerId', 'title']);
  });
});

describe('projecting confirmed titles onto the shown Window', () => {
  const confirmed = new Map([['k', 'T']]);
  const facts = { hasWindow: true, provisional: false, confirmed, applied: undefined };
  it('projects once the Window is confirmed and titles exist', () => expect(windowProjectionTitles(facts)).toBe(confirmed));
  it('waits for a cached Window, which is read-only', () => expect(windowProjectionTitles({ ...facts, provisional: true })).toBeUndefined());
  it('has nothing without a Window or without titles', () => {
    expect(windowProjectionTitles({ ...facts, hasWindow: false })).toBeUndefined();
    expect(windowProjectionTitles({ ...facts, confirmed: new Map() })).toBeUndefined();
    expect(windowProjectionTitles({ ...facts, confirmed: undefined })).toBeUndefined();
  });
  it('does not project the same map twice, and projects a new one', () => {
    expect(windowProjectionTitles({ ...facts, applied: confirmed })).toBeUndefined();
    expect(windowProjectionTitles({ ...facts, applied: new Map(confirmed) })).toBe(confirmed);
  });
});

describe('projecting confirmed titles onto the shown bot group', () => {
  const confirmed = new Map([['k', 'T']]);
  const facts = { hasGroup: true, confirmed, revision: 'r1', last: {} as { titles?: ReadonlyMap<string, string>; revision?: string } };
  it('projects for a group with titles', () => expect(groupProjectionTitles(facts)).toBe(confirmed));
  it('has nothing without a group or titles', () => {
    expect(groupProjectionTitles({ ...facts, hasGroup: false })).toBeUndefined();
    expect(groupProjectionTitles({ ...facts, confirmed: new Map() })).toBeUndefined();
  });
  it('projects again when the group revision or the title map changed, not otherwise', () => {
    expect(groupProjectionTitles({ ...facts, last: { titles: confirmed, revision: 'r1' } })).toBeUndefined();
    expect(groupProjectionTitles({ ...facts, last: { titles: confirmed, revision: 'r0' } })).toBe(confirmed);
    expect(groupProjectionTitles({ ...facts, last: { titles: new Map(confirmed), revision: 'r1' } })).toBe(confirmed);
  });
});
