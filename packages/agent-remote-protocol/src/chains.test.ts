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
