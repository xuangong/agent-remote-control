import { describe, expect, it } from 'vitest';
import { applyGroupOperation, createWindowView, isWindowGroup, type WindowBotDetails, type WindowGroup, type WindowView } from '@orchardworks/agent-remote-protocol';
import { translator } from '@orchardworks/agent-client';
import { applyMoveSteps, groupSections, inGroupOrder, rankInPlace, isPersonalGroup, orderedGroups, planMove, reorderGroup, showsGroupHeadings, type MoveStep } from './assistant-groups.js';
import { rankBetween } from './ranks.js';
import { accountNames } from './assistant-names.js';
import { projectBotRoster } from './bot-roster.js';

const binding = (id: string, title = id) => ({ hostId: 'host', providerId: 'claude', nativeSessionId: id, title });
const bot = (id: string, title = id, placement: WindowView['placement'] = 'primary') => createWindowView(id, binding(`${id}-session`, title), placement);
/** A group as the Relay stores it: `title`, its views, and bot details when it is a section. */
function group(id: string, title: string, views: WindowView[], bots?: { rank: string; members?: Record<string, WindowBotDetails>; muted?: true; notifications?: 'needs_you' }): WindowGroup {
  const primary = views.find(view => view.placement === 'primary')?.id ?? null;
  return { window: { schemaVersion: 3, id, revision: 1, title, views, selectedPrimaryViewId: primary, selectedViewId: primary ?? views[0]?.id ?? null },
    ...(bots ? { bots: { rank: bots.rank, members: bots.members ?? {}, ...(bots.muted ? { muted: true } : {}), ...(bots.notifications ? { notifications: bots.notifications } : {}) } } : {}) };
}
/** A group New assistant starts: one bot named "main", the group named after its session. */
const own = (id: string, title: string, details: WindowBotDetails = {}) => group(id, title, [createWindowView('main', binding(`${id}-session`, title), 'primary')], { rank: 'm', members: { main: details } });

describe('the default group', () => {
  // Each row: a group, and whether its assistants sit in the default group.
  const rows: Array<[string, WindowGroup, boolean]> = [
    ['started by New assistant and still named after its session', own('g', 'Fix the login'), true],
    ['renamed by its owner', { ...own('g', 'Fix the login'), window: { ...own('g', 'Fix the login').window, title: 'Login work' } }, false],
    ['a Side beside the assistant it is named after', group('g', 'Fix', [bot('main', 'Fix'), { ...bot('side', 'Other', 'attached'), attachedTo: 'main' }]), true],
    ['two primary assistants named like the group', group('g', 'Same', [bot('a', 'Same'), bot('b', 'Same')]), false],
    ['named after a history view, which is no assistant', group('g', 'Past', [createWindowView('h', { ...binding('h', 'Past'), sessionIntent: 'history' }, 'primary')]), false],
    ['named after a docked assistant', group('g', 'Docked', [bot('main', 'Docked', 'dock')]), false],
    ['made empty in the directory', group('g', 'Research', [], { rank: 'm' }), false],
  ];
  for (const [name, value, personal] of rows) it(`${personal ? 'holds' : 'does not hold'} a group ${name}`, () => expect(isPersonalGroup(value)).toBe(personal));
});

describe('group order', () => {
  it('lists the groups people made by rank, each without one just after the group before it in the catalog, and leaves out groups of one', () => {
    const groups = [group('u1', 'Window one', [bot('x')]), own('p', 'Personal'), group('b', 'B', [], { rank: 't' }), group('a', 'A', [], { rank: 'b' }),
      group('u2', 'Window two', [bot('y')]), group('tie', 'Tie', [], { rank: 't' })];
    expect(orderedGroups(groups).map(item => item.window.id)).toEqual(['u1', 'a', 'u2', 'b', 'tie']);
  });

  it('orders Window mode\'s list the same way, the assistants\' own groups after the others', () => {
    const groups = [own('p', 'Personal'), group('u', 'Window', [bot('x')]), group('b', 'B', [], { rank: 't' }), group('a', 'A', [], { rank: 'b' })];
    // The Window without a rank follows the group made before it (p, ranked m).
    expect(inGroupOrder(groups.map(item => item.window), groups).map(window => window.id)).toEqual(['a', 'u', 'b', 'p']);
  });

  // Each row: before, after, and the rank between them (undefined when none fits).
  const between: Array<[string | undefined, string | undefined, string | undefined]> = [
    [undefined, undefined, 'i'], ['m', undefined, 't'], [undefined, 'm', 'b'], ['m', 'mm', 'mb'], ['a', 'b', 'ai'], ['az', 'b', 'azi'],
    ['b', 'b', undefined], ['c', 'b', undefined], ['z'.repeat(64), undefined, undefined],
  ];
  for (const [before, after, rank] of between) it(`places ${before ?? 'the start'} < ${rank ?? 'nothing'} < ${after ?? 'the end'}`, () => expect(rankBetween(before, after)).toBe(rank));

  it('always finds a rank strictly between two ranks, never ending in 0', () => {
    const ranks = ['1', '5', '9', 'a', 'az', 'b', 'm', 'mm', 'mmm', 'n1', 'z', 'zz'];
    for (const before of [undefined, ...ranks]) for (const after of [undefined, ...ranks]) {
      if (before !== undefined && after !== undefined && before >= after) continue;
      const rank = rankBetween(before, after)!;
      expect(rank).toMatch(/^[0-9a-z]*[1-9a-z]$/);
      if (before !== undefined) expect(rank > before).toBe(true);
      if (after !== undefined) expect(rank < after).toBe(true);
    }
  });

  const listed = [group('a', 'A', [], { rank: 'b' }), group('b', 'B', [], { rank: 'm' }), group('c', 'C', [], { rank: 't' }), group('u1', 'U1', [bot('x')]), group('u2', 'U2', [bot('y')])];
  const rank = (groupId: string, value: string) => ({ groupId, operation: { type: 'section.rank', rank: value } });
  const added = (groupId: string, value: string) => ({ groupId, operation: { type: 'bots.add', rank: value } });
  // Each row: the group, the step, and the changes it makes (undefined at either end).
  const moves: Array<[string, -1 | 1, unknown]> = [
    ['b', -1, [rank('b', '6')]], ['a', -1, undefined], ['u2', 1, undefined],
    // c leads the groups without ranks made after it: moving it alone would take them along, so they get ranks first.
    ['c', -1, [rank('c', 'h'), added('u1', 'x'), added('u2', 'z')]],
    // A group without a rank gains one when it moves; the one made after it, which followed it, gets its own so it stays.
    ['u1', -1, [added('u1', 'q'), added('u2', 'z')]], ['u1', 1, [added('u1', 'zi'), added('u2', 'z')]],
    // Two groups without ranks leave no room between them: the listed groups get ranks in the order shown first.
    ['u2', -1, [added('u1', 'x'), added('u2', 'v')]], ['b', 1, [rank('b', 'v'), added('u1', 'x'), added('u2', 'z')]],
    ['c', 1, [rank('c', 'y'), added('u1', 'x'), added('u2', 'z')]],
  ];
  for (const [id, step, change] of moves) it(`moves ${id} ${step < 0 ? 'up' : 'down'}`, () => expect(reorderGroup(listed, orderedGroups(listed), id, step)).toEqual(change));
  it('lists each moved group one place up or down, the others in the order they had', () => {
    for (const [id, step] of moves.filter(([, , change]) => change).map(([id, step]) => [id, step] as const)) {
      let next = listed;
      for (const change of reorderGroup(listed, orderedGroups(listed), id, step)!) next = next.map(item => item.window.id === change.groupId ? applyGroupOperation(item, change.operation) : item);
      const before = orderedGroups(listed).map(item => item.window.id), at = before.indexOf(id);
      const expected = before.filter(item => item !== id); expected.splice(at + step, 0, id);
      expect(orderedGroups(next).map(item => item.window.id), `${id} ${step}`).toEqual(expected);
    }
  });
  it('keeps a group where it is listed when it becomes a section without a rank of its own', () => {
    const groups = [group('a', 'A', [], { rank: 'b' }), group('u', 'U', [bot('x')]), group('c', 'C', [], { rank: 't' })];
    expect(orderedGroups(groups).map(item => item.window.id)).toEqual(['a', 'u', 'c']);
    const next = groups.map(item => item.window.id === 'u' ? applyGroupOperation(item, { type: 'bots.add', rank: rankInPlace(groups, 'u') }) : item);
    expect(orderedGroups(next).map(item => item.window.id)).toEqual(['a', 'u', 'c']);
  });
});

describe('sections', () => {
  const t = translator('en');
  const groups = [own('p1', 'Fix login', { name: 'Dango' }), group('r', 'Research', [bot('r1'), bot('r2')], { rank: 'b', members: { r2: { pinned: true } } }),
    group('quiet', 'Quiet', [bot('q1')], { rank: 'c', muted: true }), own('p2', 'Write notes'), group('empty', 'Empty', [], { rank: 'd' })];
  const replies: Record<string, number> = { 'r1-session': 9, 'r2-session': 1, 'p1-session': 5, 'q1-session': 7 };
  const model = (everyone = false) => projectBotRoster(groups, [], { status: () => 'idle', t, everyone,
    reply: session => replies[session.nativeSessionId] ? { replyAt: replies[session.nativeSessionId]!, preview: 'Done.' } : undefined, unread: () => true });

  it('sections Chats by group in group order, the default group last, each by activity with pinned chats first', () => {
    const sections = groupSections(model(), groups, { order: 'activity', defaultTitle: 'Ungrouped' });
    expect(sections.map(section => [section.groupId, section.title, section.rows.map(row => `${row.groupId}/${row.viewId}`)])).toEqual([
      ['r', 'Research', ['r/r2', 'r/r1']], ['quiet', 'Quiet', ['quiet/q1']], [undefined, 'Ungrouped', ['p1/main', 'p2/main']]]);
    expect(showsGroupHeadings(sections)).toBe(true);
  });
  it('keeps an empty group in the directory, in roster order', () => {
    const sections = groupSections(model(true), groups, { order: 'roster', defaultTitle: 'Ungrouped' });
    expect(sections.map(section => [section.groupId ?? 'default', section.rows.map(row => row.viewId)])).toEqual([
      ['r', ['r2', 'r1']], ['quiet', ['q1']], ['empty', []], ['default', ['main', 'main']]]);
  });
  it('quiets a muted group: its chats are muted and its unread chats do not mark it', () => {
    const [research, quiet, ungrouped] = groupSections(model(), groups, { order: 'activity', defaultTitle: 'Ungrouped' });
    expect([research!.unread, quiet!.unread, ungrouped!.unread]).toEqual([true, undefined, true]);
    expect(quiet!.muted).toBe(true);
    expect(quiet!.rows.every(row => row.muted)).toBe(true);
  });
  it('shows no headings while one group is all there is, the default one or another', () => {
    const alone = [own('p1', 'One'), own('p2', 'Two')];
    const sections = groupSections(projectBotRoster(alone, [], { status: () => 'idle' }), alone, { order: 'activity', defaultTitle: 'Ungrouped' });
    expect(sections.map(section => section.groupId)).toEqual([undefined]);
    expect(showsGroupHeadings(sections)).toBe(false);
    const research = [group('r', 'Research', [bot('r1')], { rank: 'b' })];
    expect(showsGroupHeadings(groupSections(projectBotRoster(research, [], { status: () => 'idle' }), research, { order: 'activity', defaultTitle: 'Ungrouped' }))).toBe(false);
  });
});

describe('moving an assistant', () => {
  const t = translator('en');
  let next = 0;
  const context = (groups: readonly WindowGroup[]) => ({ names: accountNames(groups, t), newId: () => `new-${++next}` });
  /** The Relay's side of each step: the protocol's rules, applied in order; every group stays valid. */
  function run(groups: readonly WindowGroup[], steps: readonly MoveStep[]): WindowGroup[] {
    const state = applyMoveSteps(groups, steps);
    for (const item of state) expect(isWindowGroup(item)).toBe(true);
    return state;
  }
  const names = (groups: readonly WindowGroup[]) => accountNames(groups, t);

  it('takes a group of one whole into another group, giving a view the target already has a new id and keeping the name and face', () => {
    const groups = [own('p', 'Fix login'), group('r', 'Research', [createWindowView('main', undefined, 'primary'), bot('r1')], { rank: 'b' })];
    const name = names(groups).view('p', 'main');
    const plan = planMove(groups, { groupId: 'p', viewId: 'main' }, 'r', context(groups));
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.steps.map(step => step.kind)).toEqual(['edit', 'merge']);
    const after = run(groups, plan.steps);
    expect(after.map(item => item.window.id)).toEqual(['r']);
    const research = after[0]!;
    expect(plan.place.groupId).toBe('r');
    expect(research.window.views.map(view => view.id)).toEqual(['main', 'r1', plan.place.viewId]);
    expect(research.bots?.members[plan.place.viewId]).toMatchObject({ name, picture: expect.objectContaining({ shape: expect.any(String) }) });
    expect(names(after).view('r', plan.place.viewId)).toBe(name);
  });

  it('moves one assistant of a group with its Side and what closes with it, and leaves the others', () => {
    const ask = { ...createWindowView('ask', binding('ask'), 'float'), bindingPolicy: 'managed' as const, closeWith: 'a', feature: { kind: 'ask', id: 'ask-1' } };
    const groups = [group('s', 'Source', [bot('a'), { ...bot('a-side', 'a-side', 'attached'), attachedTo: 'a' }, ask, bot('b')], { rank: 'b', members: { a: { name: 'Ann', label: 'Writer' } } }),
      group('t', 'Target', [bot('t1')], { rank: 'c' })];
    const plan = planMove(groups, { groupId: 's', viewId: 'a' }, 't', context(groups));
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.steps.map(step => step.kind)).toEqual(['edit', 'transfer']);
    const [source, target] = run(groups, plan.steps);
    expect(source!.window.views.map(view => view.id)).toEqual(['b']);
    expect(target!.window.views.map(view => view.id)).toEqual(['t1', 'a', 'a-side', 'ask']);
    expect(target!.bots?.members.a).toMatchObject({ name: 'Ann', label: 'Writer' });
  });

  it('puts an assistant removed from a group into a group of its own, named after its session, which the default group holds', () => {
    const groups = [group('s', 'Source', [bot('a', 'Write the notes'), bot('b')], { rank: 'b' })];
    const plan = planMove(groups, { groupId: 's', viewId: 'a' }, undefined, context(groups));
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.steps.map(step => step.kind)).toEqual(['edit', 'create', 'transfer']);
    const after = run(groups, plan.steps);
    const created = after.find(item => item.window.id === plan.place.groupId)!;
    expect(created.window.title).toBe('Write the notes');
    expect(isPersonalGroup(created)).toBe(true);
    expect(orderedGroups(after).map(item => item.window.id)).toEqual(['s']);
  });

  it('makes a docked assistant a primary one when it leaves for a group of its own', () => {
    const groups = [group('s', 'Source', [bot('b'), bot('d', 'Docked', 'dock')], { rank: 'b' })];
    const plan = planMove(groups, { groupId: 's', viewId: 'd' }, undefined, context(groups));
    if ('refused' in plan) throw new Error(plan.refused);
    const created = run(groups, plan.steps).find(item => item.window.id === plan.place.groupId)!;
    expect(created.window.views.map(view => [view.id, view.placement])).toEqual([['d', 'primary']]);
    expect(isPersonalGroup(created)).toBe(true);
  });

  it('makes a Window without bot details a section before an assistant moves out of it or into it', () => {
    const groups = [group('w', 'Window', [bot('a'), bot('b')]), group('x', 'Other window', [bot('c')])];
    const plan = planMove(groups, { groupId: 'w', viewId: 'a' }, 'x', context(groups));
    if ('refused' in plan) throw new Error(plan.refused);
    expect(plan.steps.map(step => step.kind === 'edit' ? `edit ${step.groupId}` : step.kind)).toEqual(['edit w', 'edit x', 'transfer']);
    const [source, target] = run(groups, plan.steps);
    expect(source!.window.views.map(view => view.id)).toEqual(['b']);
    expect(target!.window.views.map(view => view.id)).toEqual(['c', 'a']);
  });

  // Each row: why a move is refused, and the move.
  const refusals: Array<[string, WindowGroup[], { groupId: string; viewId: string }, string | undefined]> = [
    ['side', [group('s', 'S', [bot('a'), { ...bot('side', 'side', 'attached'), attachedTo: 'a' }], { rank: 'b' }), group('t', 'T', [], { rank: 'c' })], { groupId: 's', viewId: 'side' }, 't'],
    ['managed', [group('s', 'S', [{ ...bot('lead'), bindingPolicy: 'managed', feature: { kind: 'team', id: 'release', metadata: { role: 'leader' } } }], { rank: 'b' }), group('t', 'T', [], { rank: 'c' })], { groupId: 's', viewId: 'lead' }, 't'],
    ['missing', [own('p', 'P')], { groupId: 'p', viewId: 'gone' }, undefined],
    ['missing', [own('p', 'P')], { groupId: 'p', viewId: 'main' }, 'nowhere'],
    ['full', [own('p', 'P'), group('t', 'T', Array.from({ length: 64 }, (_, index) => bot(`v${index}`)), { rank: 'c' })], { groupId: 'p', viewId: 'main' }, 't'],
  ];
  for (const [reason, groups, from, to] of refusals) it(`refuses a move: ${reason}`, () => expect(planMove(groups, from, to, context(groups))).toEqual({ refused: reason }));

  it('does nothing for a move to where the assistant already is', () => {
    const groups = [own('p', 'P'), group('s', 'S', [bot('a')], { rank: 'b' })];
    expect(planMove(groups, { groupId: 'p', viewId: 'main' }, undefined, context(groups))).toEqual({ steps: [], place: { groupId: 'p', viewId: 'main' } });
    expect(planMove(groups, { groupId: 's', viewId: 'a' }, 's', context(groups))).toEqual({ steps: [], place: { groupId: 's', viewId: 'a' } });
  });
});
