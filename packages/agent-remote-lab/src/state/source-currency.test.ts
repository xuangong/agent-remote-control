// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fixtureStaleness, viewStaleness, type GroupBindingLookup } from './source-currency.js';

const bound = (overrides: Partial<Extract<GroupBindingLookup, { kind: 'bound' }>> = {}): GroupBindingLookup => ({ kind: 'bound', groupId: 'g', viewId: 'v', sessionKey: 'k', ...overrides });

describe('view staleness', () => {
  it.each([
    { name: 'a plain source with no group binding', captured: undefined, lookup: { kind: 'none' } as GroupBindingLookup, stale: undefined },
    { name: 'a binding that cannot be resolved', captured: undefined, lookup: { kind: 'unresolvable' } as GroupBindingLookup, stale: 'view' },
    { name: 'a bot still at the place it was captured', captured: { groupId: 'g', viewId: 'v' }, lookup: bound(), stale: undefined },
    { name: 'a bot captured where nothing is bound now', captured: { groupId: 'g', viewId: 'v' }, lookup: { kind: 'none' } as GroupBindingLookup, stale: 'view' },
    { name: 'a bot whose group changed', captured: { groupId: 'g', viewId: 'v' }, lookup: bound({ groupId: 'other' }), stale: 'view' },
    { name: 'a bot whose view changed', captured: { groupId: 'g', viewId: 'v' }, lookup: bound({ viewId: 'other' }), stale: 'view' },
    { name: 'a view that now shows another session', captured: undefined, lookup: bound({ sessionKey: 'other' }), stale: 'view' },
    { name: 'a view that still shows the source', captured: undefined, lookup: bound(), stale: undefined },
  ])('judges $name', ({ captured, lookup, stale }) => {
    expect(viewStaleness({ captured, lookup, sourceKey: 'k' })).toBe(stale);
  });
});

describe('fixture staleness', () => {
  const agent = { id: 'a1', providerId: 'codex', nativeSessionId: 'n1' };
  const source = { agentId: 'a1', providerId: 'codex', nativeSessionId: 'n1' };
  const input = { slotSelectionKey: 'k', sourceKey: 'k', agent, source };

  it('is current when the slot, agent and native session all match', () => {
    expect(fixtureStaleness(input)).toBeUndefined();
  });

  it.each([
    { name: 'no slot for the view', change: { slotSelectionKey: undefined }, stale: 'view' },
    { name: 'a slot that selects another session', change: { slotSelectionKey: 'other' }, stale: 'view' },
    { name: 'no agent yet', change: { agent: undefined }, stale: 'connecting' },
    { name: 'another agent', change: { agent: { ...agent, id: 'a2' } }, stale: 'agent' },
    { name: 'another provider', change: { agent: { ...agent, providerId: 'claude' } }, stale: 'native' },
    { name: 'another native session', change: { agent: { ...agent, nativeSessionId: 'n2' } }, stale: 'native' },
    { name: 'an agent that has no native session yet', change: { agent: { ...agent, nativeSessionId: undefined } }, stale: 'native' },
  ])('says $stale for $name', ({ change, stale }) => {
    expect(fixtureStaleness({ ...input, ...change })).toBe(stale);
  });

  it('judges the view before the agent', () => {
    expect(fixtureStaleness({ ...input, slotSelectionKey: undefined, agent: undefined })).toBe('view');
  });
});
