// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bindPlan, focusesVisibleSession, returnsToParent } from './session-binding.js';

const ordinaryOpen = { restoreView: false, onRestoring: false };

describe('opening a session that is already on screen', () => {
  it('focuses the view for an ordinary open', () => expect(focusesVisibleSession(ordinaryOpen)).toBe(true));
  it.each([
    ['a target primary view', { targetPrimaryViewId: 'v' }],
    ['a primary placement', { placement: 'primary' }],
    ['a primary slot', { primarySlot: 's' }],
    ['a history intent', { sessionIntent: 'history' }],
    ['a choice about keeping the original', { keepOriginal: false }],
    ['a restore of the layout', { restoreView: true }],
    ['a take over', { takeOver: 'generation' }],
    ['a restoring callback', { onRestoring: true }],
  ])('opens it again with %s', (_name, change) => expect(focusesVisibleSession({ ...ordinaryOpen, ...change })).toBe(false));
  it('still focuses for a dock or float placement and for a subagent intent', () => {
    expect(focusesVisibleSession({ ...ordinaryOpen, placement: 'dock' })).toBe(true);
    expect(focusesVisibleSession({ ...ordinaryOpen, sessionIntent: 'subagent' })).toBe(true);
  });
});

describe('returning to a native parent', () => {
  const back = { restoreView: false, isAncestor: true };
  it('stays in the tracked family for an ancestor', () => expect(returnsToParent(back)).toBe(true));
  it('leaves the Track for a session that is not an ancestor', () => expect(returnsToParent({ ...back, isAncestor: false })).toBe(false));
  it.each([['a history view', { sessionIntent: 'history' }], ['a primary slot', { primarySlot: 's' }], ['a restore', { restoreView: true }]])('leaves the Track for %s', (_name, change) => {
    expect(returnsToParent({ ...back, ...change })).toBe(false);
  });
});

describe('binding a session over a view', () => {
  const botOver = { hasGroup: true, targetIsBot: true, targetId: 'bot', targetPlacement: 'primary', rebindsBot: false, botAppearance: true, sameSession: false, existingBot: undefined };
  it('binds in place when the view is not a bot, there is no group, or the group shows no bot details', () => {
    expect(bindPlan({ ...botOver, targetIsBot: false })).toEqual({ kind: 'in-place' });
    expect(bindPlan({ ...botOver, hasGroup: false })).toEqual({ kind: 'in-place' });
    expect(bindPlan({ ...botOver, botAppearance: false })).toEqual({ kind: 'in-place' });
  });
  it('binds in place when the session is the bot\'s own, and for a history view of it', () => {
    expect(bindPlan({ ...botOver, sameSession: true })).toEqual({ kind: 'in-place' });
    expect(bindPlan({ ...botOver, sessionIntent: 'history' })).toEqual({ kind: 'in-place' });
  });
  it('opens beside a bot for another session, as a primary group when the bot is primary', () => {
    expect(bindPlan(botOver)).toEqual({ kind: 'open-beside', placement: 'primary' });
  });
  it('keeps a bot whose session the Host reported missing: another session still opens beside it, as at the baseline', () => {
    // The plan takes no fact about a missing session. The view shows as empty, but it is still a bot of the group, so it keeps its
    // place and the directory's session takes a new primary group next to it; the same rule 6 answer as for a bot with a live session.
    const facts = { ...botOver, targetIsBot: true, hasGroup: true, botAppearance: true };
    expect(bindPlan(facts)).toEqual({ kind: 'open-beside', placement: 'primary' });
    expect(bindPlan({ ...facts, targetPlacement: 'dock' })).toEqual({ kind: 'open-beside', placement: 'dock', afterId: 'bot' });
  });
  it('opens beside in the dock after the bot, or floating, where the bot stands', () => {
    expect(bindPlan({ ...botOver, targetPlacement: 'dock' })).toEqual({ kind: 'open-beside', placement: 'dock', afterId: 'bot' });
    expect(bindPlan({ ...botOver, targetPlacement: 'float' })).toEqual({ kind: 'open-beside', placement: 'float' });
  });
  it('opens a Side\'s replacement as a primary group', () => {
    expect(bindPlan({ ...botOver, targetPlacement: 'attached' })).toEqual({ kind: 'open-beside', placement: 'primary' });
  });
  it('opens beside when the group refuses the edit even if bot details are off or the session is the bot\'s own', () => {
    expect(bindPlan({ ...botOver, rebindsBot: true, botAppearance: false })).toEqual({ kind: 'open-beside', placement: 'primary' });
    expect(bindPlan({ ...botOver, rebindsBot: true, sameSession: true })).toEqual({ kind: 'open-beside', placement: 'primary' });
    expect(bindPlan({ ...botOver, rebindsBot: true, sessionIntent: 'history' })).toEqual({ kind: 'open-beside', placement: 'primary' });
  });
  it('selects the bot view that already shows the session, and opens it when that view is primary', () => {
    expect(bindPlan({ ...botOver, existingBot: { id: 'other', placement: 'primary' } })).toEqual({ kind: 'select-existing', viewId: 'other', primary: true });
    expect(bindPlan({ ...botOver, existingBot: { id: 'other', placement: 'dock' } })).toEqual({ kind: 'select-existing', viewId: 'other', primary: false });
  });
  it('ignores an existing bot view when it binds in place', () => {
    expect(bindPlan({ ...botOver, botAppearance: false, existingBot: { id: 'other', placement: 'primary' } })).toEqual({ kind: 'in-place' });
  });
});
