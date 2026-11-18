import { describe, expect, it } from 'vitest';
import { buildRoleEvidence, buildSuccessionChain, buildSuccessionReplay } from '../testing/succession.js';
import { replayRoleKey, roleKey } from './locator.js';
import { canPruneSession, continuesRole, latestReplayByRole, newerFavoritesHints, resolveLocator, roleContextOf, sourceStaleness } from './evidence.js';

const at = (nativeSessionId: string, extra: object = {}) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, ...extra });
const abc = buildRoleEvidence(['A', 'B', 'C']);
const resolve = (over: Partial<Parameters<typeof resolveLocator>[0]> & { selected?: string } = {}) => {
  const { selected = 'A', ...rest } = over;
  return resolveLocator({ ready: true, evidenceStale: false, selection: at(selected), viewIsHistory: false, nativePrefixOnly: false, evidence: [abc], replays: abc.replays, ...rest });
};

describe('resolveLocator', () => {
  it('sends a predecessor to the conversation current session', () => {
    expect(resolve({ selected: 'A' })).toEqual({ status: 'resolved', target: at('C') });
    expect(resolve({ selected: 'B' })).toEqual({ status: 'resolved', target: at('C') });
    expect(resolve({ selected: 'C' })).toEqual({ status: 'resolved', target: at('C') });
  });
  it('leaves a session that no replay mentions alone', () => {
    expect(resolve({ selected: 'Z' })).toEqual({ status: 'resolved', target: at('Z') });
  });
  it('keeps the other fields of the selection when it resolves to the current session', () => {
    expect(resolve({ selection: at('A', { title: 'Old', viewId: 'view' }) } as never)).toMatchObject({ target: { nativeSessionId: 'C', title: 'Old', viewId: 'view' } });
  });
  it('keeps a history view on its own session and names its role', () => {
    expect(resolve({ selected: 'A', viewIsHistory: true })).toEqual({ status: 'resolved', target: at('A'), historyRoleId: 'primary' });
  });
  it('keeps a child session on its own locator, before any evidence is read', () => {
    expect(resolve({ selection: at('A', { parentNativeSessionId: 'P' }), evidence: [], replays: [] } as never)).toMatchObject({ status: 'resolved', target: { nativeSessionId: 'A' } });
  });
  it.each([
    ['discovery has not finished', { ready: false }, { kind: 'synchronizing', stale: false }],
    ['evidence is stale', { evidenceStale: true }, { kind: 'synchronizing', stale: true }],
    ['discovery has not finished and evidence is stale', { ready: false, evidenceStale: true }, { kind: 'synchronizing', stale: false }],
  ])('refuses while %s', (_name, over, refusal) => {
    expect(resolve(over)).toEqual({ status: 'refused', refusal });
  });
  it('refuses a mentioned session whose role has no confirmed evidence', () => {
    expect(resolve({ evidence: [] })).toEqual({ status: 'refused', refusal: { kind: 'error', message: 'The current session locator could not be verified. The original history is preserved.' } });
  });
  it('refuses a session that two roles confirm', () => {
    const other = buildRoleEvidence(['A', 'B'], { roleId: 'second', origin: 'A' });
    expect(resolve({ evidence: [abc, other], replays: [...abc.replays, ...other.replays] })).toEqual({ status: 'refused', refusal: { kind: 'error', message: 'The session has conflicting current role identities.' } });
  });
  it('lets a native prefix follow prompt edits to the current session', () => {
    const edits = buildRoleEvidence(['A', 'B', 'C'], { promptEdit: true });
    expect(resolve({ selected: 'A', nativePrefixOnly: true, evidence: [edits], replays: edits.replays })).toMatchObject({ status: 'resolved', target: { nativeSessionId: 'C' } });
  });
  it('does not route a native prefix across a generic Handoff', () => {
    expect(() => resolve({ selected: 'A', nativePrefixOnly: true })).toThrow('across generic succession');
  });
  it('ignores the native prefix rule for a history view', () => {
    expect(resolve({ selected: 'A', nativePrefixOnly: true, viewIsHistory: true })).toMatchObject({ status: 'resolved', historyRoleId: 'primary' });
  });
});

describe('latestReplayByRole', () => {
  const primary = buildSuccessionChain(['A', 'B', 'C']);
  const second = buildSuccessionChain(['X', 'Y'], { roleId: 'second' });
  it('keeps the highest revision of each role', () => {
    const latest = latestReplayByRole('scope', [...primary, ...second]);
    expect([...latest.values()].map(replay => replay.to.nativeSessionId)).toEqual(['C', 'Y']);
    expect([...latest.keys()]).toEqual([replayRoleKey('scope', primary[0]!), replayRoleKey('scope', second[0]!)]);
  });
  it('does not depend on the order replays arrive', () => {
    expect([...latestReplayByRole('scope', [...primary].reverse()).values()].map(replay => replay.projection.role.revision)).toEqual([3]);
  });
  it('lets the caller leave roles out', () => {
    const only = latestReplayByRole('scope', [...primary, ...second], replay => replay.projection.role.id === 'second');
    expect([...only.values()].map(replay => replay.to.nativeSessionId)).toEqual(['Y']);
  });
  it('gives nothing for no replays', () => { expect(latestReplayByRole('scope', []).size).toBe(0); });
  it('names roles by scope, Host, Controller and id', () => {
    expect(replayRoleKey('s', buildSuccessionReplay())).toBe(roleKey({ scope: 's', hostId: 'host', controllerId: 'installation', roleId: 'primary' }));
    expect(replayRoleKey('s', buildSuccessionReplay({ hostId: 'other' }))).not.toBe(replayRoleKey('s', buildSuccessionReplay()));
    expect(replayRoleKey('t', buildSuccessionReplay())).not.toBe(replayRoleKey('s', buildSuccessionReplay()));
  });
});

describe('continuesRole', () => {
  const key = replayRoleKey('scope', abc.replays[0]!);
  const desired = { roleKey: key, hostId: 'host', providerId: 'recorded', nativeSessionId: 'C' };
  const continues = (over: Partial<Parameters<typeof continuesRole>[0]> = {}) => continuesRole({ scope: 'scope', selection: at('C'), explicitView: false, history: false, desired, replays: abc.replays, ...over });
  it.each([
    ['the shown session itself', { selection: at('C') }, true],
    ['a predecessor of the shown role', { selection: at('A') }, true],
    ['an unrelated session', { selection: at('Z') }, false],
    ['an explicit view', { explicitView: true }, false],
    ['a history navigation', { history: true }, false],
    ['a shown conversation with no role', { desired: { ...desired, roleKey: undefined } }, false],
    ['nothing shown', { desired: undefined }, false],
    ['a replay of another role', { selection: at('A'), replays: buildSuccessionChain(['A', 'B'], { roleId: 'second' }) }, false],
    ['the shown session on another Host', { selection: at('C', { hostId: 'elsewhere' }) }, false],
  ])('for %s', (_name, over, expected) => {
    expect(continues(over as never)).toBe(expected);
  });
});

describe('canPruneSession', () => {
  const key = replayRoleKey('scope', abc.replays[0]!);
  const roles = (over = {}) => [{ key, appliedRevision: 3, committedRevision: 3, operationId: 'primary-op-3', ...over }];
  const progress = (over = {}) => [{ hostId: 'host', controllerId: 'installation', roleId: 'primary', roleRevision: 3, operationId: 'primary-op-3', status: 'applied', ...over }];
  const can = (over: Partial<Parameters<typeof canPruneSession>[0]> = {}) => canPruneSession({ scope: 'scope', session: at('A'), viewRoleKeys: [], replays: abc.replays, roles: roles(), progress: progress(), ...over });
  it.each([
    ['everything applied and reported', {}, true],
    ['a session no role mentions', { session: at('Z'), replays: [] }, true],
    ['a role that applied an older revision', { roles: roles({ appliedRevision: 2 }) }, false],
    ['a role with no checkpoint', { roles: [] }, false],
    ['a view of a role with no checkpoint', { session: at('Z'), replays: [], viewRoleKeys: ['other-role'] }, false],
    ['no progress from the Relay', { progress: undefined }, false],
    ['progress for another revision', { progress: progress({ roleRevision: 2 }) }, false],
    ['progress for another operation', { progress: progress({ operationId: 'other' }) }, false],
    ['progress that is not applied', { progress: progress({ status: 'pending' }) }, false],
    ['progress for another role', { progress: progress({ roleId: 'second' }) }, false],
    ['progress from another Controller', { progress: progress({ controllerId: 'other' }) }, false],
  ])('for %s', (_name, over, expected) => {
    expect(can(over as never)).toBe(expected);
  });
});

describe('newerFavoritesHints', () => {
  const key = replayRoleKey('scope', abc.replays[0]!);
  const roles = [{ key, appliedRevision: 2, committedRevision: 2 }];
  const item = (over = {}) => ({ hostId: 'host', controllerId: 'installation', roleId: 'primary', roleRevision: 3, operationId: 'op-3', status: 'applied', ...over });
  const hints = (progress: ReturnType<typeof item>[], seen = new Map()) => newerFavoritesHints({ scope: 'scope', roles, progress, seen });
  it('reports a revision ahead of the one applied here', () => {
    expect(hints([item()])).toEqual([[key, { revision: 3, operationId: 'op-3', status: 'applied' }]]);
  });
  it.each([
    ['the same revision as applied', item({ roleRevision: 2 })],
    ['an older revision', item({ roleRevision: 1 })],
    ['a role this page does not hold', item({ roleId: 'second' })],
  ])('ignores %s', (_name, progress) => { expect(hints([progress])).toEqual([]); });
  it('reports the same newer progress once', () => {
    const seen = new Map([[key, { revision: 3, operationId: 'op-3', status: 'applied' }]]);
    expect(hints([item()], seen)).toEqual([]);
  });
  it.each([
    ['another operation at the same revision', item({ operationId: 'op-3b' })],
    ['another status at the same revision', item({ status: 'pending' })],
    ['a newer revision', item({ roleRevision: 4 })],
  ])('reports %s again', (_name, progress) => {
    const seen = new Map([[key, { revision: 3, operationId: 'op-3', status: 'applied' }]]);
    expect(hints([progress], seen)).toHaveLength(1);
  });
  it('does not go back to an older hint than one already seen', () => {
    const seen = new Map([[key, { revision: 4, operationId: 'op-4', status: 'applied' }]]);
    expect(hints([item()], seen)).toEqual([]);
  });
  it('counts a repeated entry once within one report', () => {
    expect(hints([item(), item()])).toHaveLength(1);
  });
});

describe('sourceStaleness', () => {
  const agent = { id: 'agent-B', providerId: 'recorded', runtimeInfo: { providerId: 'recorded', sessionId: 'B' } };
  const source = { ...at('B'), agentId: 'agent-B' };
  const stale = (over: Partial<Parameters<typeof sourceStaleness>[0]> = {}) => sourceStaleness({ inactive: false, viewMatches: true, bound: false, agent, source, ...over });
  it.each([
    ['a source whose connection is its native session', {}, undefined],
    ['a page without authority', { inactive: true }, 'inactive'],
    ['a view that moved on', { viewMatches: false }, 'view'],
    ['authority lost and the view moved', { inactive: true, viewMatches: false }, 'inactive'],
    ['a view bound to this source', { bound: true, agent: undefined }, undefined],
    ['a connection that has not read its session', { agent: undefined }, 'connecting'],
    ['a reattached runtime with another agent id', { agent: { ...agent, id: 'agent-other' } }, 'agent'],
    ['another provider', { agent: { ...agent, providerId: 'other' } }, 'native'],
    ['another runtime provider', { agent: { ...agent, runtimeInfo: { ...agent.runtimeInfo, providerId: 'other' } } }, 'native'],
    ['another native session', { agent: { ...agent, runtimeInfo: { ...agent.runtimeInfo, sessionId: 'C' } } }, 'native'],
  ])('for %s', (_name, over, expected) => {
    expect(stale(over as never)).toBe(expected);
  });
});

describe('roleContextOf', () => {
  const native = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'recorded', nativeSessionId });
  const context = (over: Partial<Parameters<typeof roleContextOf>[0]> = {}) => roleContextOf({
    viewRevision: 3, viewTarget: native('C'), viewSession: at('C'), evidence: abc,
    checkpoint: { key: 'k', appliedRevision: 3, committedRevision: 3, operationId: 'primary-op-3', to: native('C') }, ...over,
  });
  it('gives the Handoff a confirmed role view stands on', () => {
    expect(context()).toEqual({ operationId: 'primary-op-3', target: native('C') });
  });
  it.each([
    ['no evidence', { evidence: undefined }],
    ['no checkpoint', { checkpoint: undefined }],
    ['a view behind the confirmed revision', { viewRevision: 2 }],
    ['a checkpoint that applied an older revision', { checkpoint: { key: 'k', appliedRevision: 2, committedRevision: 3, operationId: 'o', to: native('C') } }],
    ['a checkpoint that committed an older revision', { checkpoint: { key: 'k', appliedRevision: 3, committedRevision: 2, operationId: 'o', to: native('C') } }],
    ['a view on a session that is not the confirmed locator', { viewSession: at('B') }],
    ['a checkpoint for another target', { checkpoint: { key: 'k', appliedRevision: 3, committedRevision: 3, operationId: 'o', to: native('B') } }],
  ])('gives nothing for %s', (_name, over) => {
    expect(context(over as never)).toBeUndefined();
  });
});
