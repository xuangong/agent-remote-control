import { describe, expect, it } from 'vitest';
import type { SessionSuccessionCurrent, SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { buildSuccessionChain, buildSuccessionCurrent } from '../testing/succession.js';
import { roleKey, sessionKey } from './locator.js';
import { sessionSuccessionHistory } from './history.js';

const session = (nativeSessionId: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, title: `Session ${nativeSessionId}` });
const chain = buildSuccessionChain(['A', 'B', 'C']);
const current = buildSuccessionCurrent(chain);
const titles = new Map(['A', 'B', 'C'].map(id => [sessionKey(session(id)), `Session ${id}`]));
const navigate = (selected: string, intent?: 'history', replays: SessionSuccessionReplay[] = chain, confirmed: SessionSuccessionCurrent | undefined = current) =>
  sessionSuccessionHistory({ scope: 'scope', replays, current: confirmed, selected: session(selected), intent, titles });

describe('sessionSuccessionHistory', () => {
  it('names the current session with its predecessor and older ancestors nearest first', () => {
    const result = navigate('C')!;
    expect(result.history).toBe(false);
    expect(result.session.nativeSessionId).toBe('C');
    expect(result.predecessor?.nativeSessionId).toBe('B');
    expect(result.ancestors.map(item => item.nativeSessionId)).toEqual(['A']);
    expect(result.current.nativeSessionId).toBe('C');
    expect(result.roleKey).toBe(roleKey({ scope: 'scope', hostId: 'host', controllerId: 'installation', roleId: 'primary' }));
  });
  it('reaches an earlier session only with history intent, and then marks the view as history', () => {
    expect(navigate('B')).toBeUndefined();
    const past = navigate('A', 'history')!;
    expect(past.history).toBe(true);
    expect(past.predecessor).toBeUndefined();
    expect(past.current.nativeSessionId).toBe('C');
    expect(navigate('C', 'history')!.history).toBe(false);
  });
  it('shows an ID, not a title, where no title is known', () => {
    const result = sessionSuccessionHistory({ scope: 'scope', replays: chain, current, selected: session('C') })!;
    expect(result.predecessor).toEqual({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'B' });
    expect(result.ancestors).toEqual([{ hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'A' }]);
  });
  it.each([
    ['no confirmed current role', (state: { replays: SessionSuccessionReplay[]; confirmed?: SessionSuccessionCurrent }) => { state.confirmed = undefined; }],
    ['a gap at the start of the chain', (state: { replays: SessionSuccessionReplay[] }) => { state.replays = state.replays.slice(1); }],
    ['a replay with another origin', (state: { replays: SessionSuccessionReplay[] }) => { state.replays[1]!.projection.role.origin.nativeSessionId = 'X'; }],
    ['a confirmed role that is not the last replay', (state: { confirmed?: SessionSuccessionCurrent }) => { state.confirmed!.role.current.nativeSessionId = 'D'; }],
    ['a confirmed role on another Controller', (state: { confirmed?: SessionSuccessionCurrent }) => { state.confirmed!.role.current.controllerId = 'other'; }],
    ['a duplicated replay', (state: { replays: SessionSuccessionReplay[] }) => { state.replays.push(state.replays[1]!); }],
    ['a replay that does not start where the last ended', (state: { replays: SessionSuccessionReplay[] }) => { state.replays[1]!.projection.receipt.from.nativeSessionId = 'Q'; }],
    ['a revision that skips', (state: { replays: SessionSuccessionReplay[] }) => { state.replays[1]!.projection.receipt.expectedRevision = 5; }],
    ['a first replay that does not leave the origin', (state: { replays: SessionSuccessionReplay[] }) => { state.replays[0]!.projection.receipt.from.nativeSessionId = 'Q'; }],
    ['another workspace', (state: { replays: SessionSuccessionReplay[] }) => { state.replays[0]!.projection.role.workspace.canonicalCwd = '/elsewhere'; }],
  ])('refuses history with %s', (_name, damage) => {
    const state: { replays: SessionSuccessionReplay[]; confirmed?: SessionSuccessionCurrent } = { replays: structuredClone(chain), confirmed: structuredClone(current) };
    damage(state);
    expect(sessionSuccessionHistory({ scope: 'scope', replays: state.replays, current: state.confirmed, selected: session('C'), titles })).toBeUndefined();
  });
  it('refuses a session the chain does not contain', () => {
    expect(navigate('X')).toBeUndefined();
  });
  it('keeps a Host out of the chain of another Host', () => {
    const other = buildSuccessionCurrent(buildSuccessionChain(['A', 'B', 'C'], { hostId: 'elsewhere' }));
    expect(navigate('C', undefined, chain, other)).toBeUndefined();
  });
});
