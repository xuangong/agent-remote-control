import { describe, expect, it } from 'vitest';
import { CHAIN_APPROVAL_LIMIT, isBotChain, isChainAction } from './chains.js';
import { isTeamHostCall } from './team.js';

const chain = { id: 'c_' + '1'.repeat(16), cause: 'person', bot: 'b_' + '1'.repeat(32), bots: ['b_' + '1'.repeat(32)], messages: 0, turns: 0, created: 0, depth: 0, usage: { tokens: 0 }, startedAt: 1, updatedAt: 1 };
const owner = { providerId: 'claude', nativeSessionId: 'native' };

describe('standing approvals of a chain', () => {
  it('are part of the chain record, bounded, and ended by the person from the audit', () => {
    expect(isBotChain({ ...chain, approvals: [{ cwd: '/repo', at: 2, applied: 3 }] })).toBe(true);
    expect(isBotChain({ ...chain, approvals: [{ cwd: '/repo', at: 2 }] })).toBe(false);
    expect(isBotChain({ ...chain, approvals: Array.from({ length: CHAIN_APPROVAL_LIMIT + 1 }, (_, n) => ({ cwd: `/repo${n}`, at: 2, applied: 0 })) })).toBe(false);
    expect(isChainAction({ action: 'revoke_approval', chainId: chain.id, cwd: '/repo' })).toBe(true);
    expect(isChainAction({ action: 'revoke_approval', chainId: chain.id })).toBe(false);
  });

  it('are asked and granted by a Host call naming the kind and the folder', () => {
    expect(isTeamHostCall({ action: 'chain_approval', owner, cause: { kind: 'framed' }, cwd: '/repo' })).toBe(true);
    expect(isTeamHostCall({ action: 'chain_approval', owner, cwd: '/repo', grant: true })).toBe(true);
    expect(isTeamHostCall({ action: 'chain_approval', owner, cwd: '/repo', grant: false })).toBe(false);
    expect(isTeamHostCall({ action: 'chain_approval', owner })).toBe(false);
  });
});

describe('the person\'s webhook routine actions', () => {
  const bot = 'b_' + '1'.repeat(32);
  it('sets an event routine, with the choice to let its sub-session change files, and rotates its secret; and refuses what is not a routine', () => {
    expect(isChainAction({ action: 'routine_set', botId: bot, name: 'Deploy failed', schedule: { kind: 'event' }, prompt: 'Triage it.', workspace: 'same' })).toBe(true);
    expect(isChainAction({ action: 'routine_set', botId: bot, name: 'Deploy failed', schedule: { kind: 'event' }, workspace: 'read_only' })).toBe(false);
    expect(isChainAction({ action: 'routine_rotate_hook', botId: bot, name: 'Deploy failed' })).toBe(true);
    expect(isChainAction({ action: 'routine_rotate_hook', botId: bot })).toBe(false);
  });
  it('keeps the fields a webhook routine and its runs hold within bounds', async () => {
    const { isRoutine, HOOK_BATCH_LIMIT } = await import('./routines.js');
    const routine = { id: 'r1', name: 'Deploy failed', schedule: { kind: 'event' }, by: 'person', anchor: 1, runCount: 0, runs: [], hook: { id: 'a'.repeat(12), hash: 'b'.repeat(64) }, events: ['x'], eventsDropped: 2, lastEventAt: 5 };
    expect(isRoutine(routine)).toBe(true);
    expect(isRoutine({ ...routine, hook: { id: 'short', hash: 'b'.repeat(64) } })).toBe(false);
    expect(isRoutine({ ...routine, events: Array.from({ length: HOOK_BATCH_LIMIT + 1 }, () => 'x') })).toBe(false);
    expect(isRoutine({ ...routine, runs: [{ n: 1, trigger: 'event', dueAt: 1, state: 'running', events: 3 }] })).toBe(true);
  });
});
