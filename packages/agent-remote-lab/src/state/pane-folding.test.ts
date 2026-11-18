// @vitest-environment node
import { applyWindowOperation } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';
import { buildBinding, buildGroup, buildView, buildWindow } from '../test/window-builders.js';
import { awakeDetails, closeOperation, foldsOnClose, isAsleep, paneFolding, restorePlan } from './pane-folding.js';

const bot = buildView('B', 'dock');
const ask = buildView('K', 'dock', { binding: buildBinding('K', { parentNativeSessionId: 'B' }) });
const window = buildWindow([buildView('A', 'primary'), bot], 'A');

describe('what folds on close', () => {
  it('folds a bot of a group in Bot appearance and closes any other view', () => {
    const group = buildGroup(window);
    expect(foldsOnClose(bot, group, false)).toBe(true);
    expect(foldsOnClose(ask, group, false)).toBe(false);
    expect(foldsOnClose(buildView('H', 'primary', { binding: buildBinding('H', { sessionIntent: 'history' }) }), group, false)).toBe(false);
    expect(foldsOnClose(undefined, group, false)).toBe(false);
  });

  it('closes when the group is not in Bot appearance or the bot session is missing', () => {
    expect(foldsOnClose(bot, buildGroup(window, { presentation: { bots: false } as never }), false)).toBe(false);
    expect(foldsOnClose(bot, undefined, false)).toBe(false);
    expect(foldsOnClose(bot, buildGroup(window), true)).toBe(false);
  });

  it('turns the × into a fold or a close', () => {
    expect(closeOperation(window, 'B', true)).toEqual({ type: 'view.collapse', viewId: 'B', collapsed: true });
    expect(closeOperation(window, 'B', false)).toEqual({ type: 'view.close', viewId: 'B' });
  });

  it('moves the selection off a folded pane as a close would', () => {
    const selected = buildWindow([buildView('A', 'primary'), buildView('B', 'primary')], 'B');
    const folded = applyWindowOperation(selected, closeOperation(selected, 'B', true));
    expect(folded.selectedViewId).toBe('A');
    expect(folded.views.find(view => view.id === 'B')?.collapsed).toBe(true);
  });
});

describe('how a pane presents', () => {
  const asleep = buildGroup(window, { asleep: ['B'] });
  it.each([
    { name: 'a collapsed bot on desktop', group: buildGroup(window), view: { ...bot, collapsed: true }, compact: false, missing: false, kind: 'folded' },
    { name: 'a sleeping bot on desktop', group: asleep, view: bot, compact: false, missing: false, kind: 'folded' },
    { name: 'a sleeping bot on a compact layout', group: asleep, view: bot, compact: true, missing: false, kind: 'asleep' },
    { name: 'a collapsed bot on a compact layout', group: buildGroup(window), view: { ...bot, collapsed: true }, compact: true, missing: false, kind: 'plain' },
    { name: 'an awake bot', group: buildGroup(window), view: bot, compact: false, missing: false, kind: 'plain' },
    { name: 'a sleeping bot whose session is missing', group: asleep, view: bot, compact: false, missing: true, kind: 'plain' },
    { name: 'a sleeping Ask child', group: buildGroup(window, { asleep: ['K'] }), view: ask, compact: false, missing: false, kind: 'plain' },
  ])('shows $name as $kind', ({ group, view, compact, missing, kind }) => {
    expect(paneFolding(view, group, { compact, sessionMissing: missing }).kind).toBe(kind);
  });

  it('presents no view as plain', () => {
    expect(paneFolding(undefined, buildGroup(window), { compact: false, sessionMissing: false }).kind).toBe('plain');
  });

  it('reads sleep from the group details', () => {
    expect(isAsleep(asleep, 'B')).toBe(true);
    expect(isAsleep(asleep, 'A')).toBe(false);
    expect(isAsleep(undefined, 'B')).toBe(false);
    expect(isAsleep(buildGroup(window, { bots: false }), 'B')).toBe(false);
  });
});

describe('restoring a pane', () => {
  it('selects an unselected pane and expands a collapsed one in the same edit', () => {
    const view = { ...bot, collapsed: true };
    expect(restorePlan(window, view, false).select).toEqual({ type: 'batch', operations: [{ type: 'view.collapse', viewId: 'B', collapsed: false }, { type: 'view.select', viewId: 'B' }] });
    expect(restorePlan(window, bot, false).select).toEqual({ type: 'view.select', viewId: 'B' });
  });

  it('does nothing to a selected pane that is open', () => {
    expect(restorePlan(buildWindow([bot], 'B'), bot, false).select).toBeUndefined();
  });

  it('expands a selected pane that is collapsed', () => {
    const view = { ...bot, collapsed: true };
    expect(restorePlan(buildWindow([view], 'B'), view, false).select).toBeDefined();
  });

  it('wakes a sleeping bot and keeps its other details', () => {
    expect(restorePlan(window, bot, true).wake).toBe(true);
    expect(restorePlan(window, bot, false).wake).toBe(false);
    expect(awakeDetails({ asleep: true, name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(awakeDetails(undefined)).toEqual({});
  });
});
