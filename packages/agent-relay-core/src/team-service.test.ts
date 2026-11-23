import { describe, expect, it } from 'vitest';
import { createBrokerState } from './broker-state.js';
import type { Host, RemoteHostBrokerState } from './broker-types.js';
import { createTeamService } from './team-service.js';

const NOW = 1_000;
const host = (id: string, extra: Partial<Host> = {}): Host => ({ id, installationId: `installation-${id}`, name: id, providers: [], legacyDsh: false, generation: 1, pending: new Map(), streams: new Map(), ...extra });
const saved = (): RemoteHostBrokerState => ({ keys: [], hosts: [], bindings: [], creations: [] });

function service(hosts: Host[] = [], rpcResult: { status: number; body: string } = { status: 200, body: '{"ok":true}' }) {
  const saves: RemoteHostBrokerState[] = [];
  const brokerState = createBrokerState({ initialState: saved(), now: () => NOW, onStateChange: async state => { saves.push(state); }, keepsAssociations: false, keepsSharing: false });
  const byId = new Map(hosts.map(item => [item.id, item]));
  for (const item of hosts) brokerState.hosts.set(item.id, item);
  const requireHost = (id: string) => { const found = byId.get(id); if (!found) throw new Error('Host unavailable.'); return found; };
  const calls: Array<{ path: string; body: string | undefined }> = [];
  const parts = createTeamService({
    brokerState, options: {}, now: () => NOW, requireHost,
    rpc: (async (_host: Host, _method: string, path: string, _query: unknown, body?: string) => { calls.push({ path, body }); return { status: rpcResult.status, headers: {}, body: rpcResult.body }; }) as never,
    assertAssociationOpen: () => {}, associationSource: (() => { throw new Error('unexpected'); }) as never, prefixRecords: (() => []) as never,
  });
  return { ...parts, brokerState, saves, calls };
}

describe('the chains of an account', () => {
  it('saves a chain with the broker state, and a broker loads it back', async () => {
    const s = service();
    const chain = { id: 'c_0123456789abcdef', cause: 'person' as const, bot: 'b_' + '1'.repeat(32), bots: ['b_' + '1'.repeat(32)], messages: 1, turns: 0, created: 0, depth: 1, usage: { tokens: 0 }, startedAt: NOW, updatedAt: NOW };
    const scope = { id: chain.id, bots: new Set<string>(), messages: 1, created: 0, depth: 1 };
    await s.teams.chains.record(scope, { cause: 'person', bot: chain.bot });
    expect(s.saves.at(-1)?.chains).toEqual([chain]);
    const loaded = createBrokerState({ initialState: s.saves.at(-1)!, now: () => NOW, onStateChange: async () => {}, keepsAssociations: false, keepsSharing: false });
    expect(loaded.chains).toEqual([chain]);
    expect(() => createBrokerState({ initialState: { ...saved(), chains: [{ ...chain, id: 'not a chain' }] }, now: () => NOW, onStateChange: async () => {}, keepsAssociations: false, keepsSharing: false })).toThrow('Invalid saved chains.');
  });
});

describe('the Host guards of Teams', () => {
  it('refuses a Host that has not announced Team management', async () => {
    const s = service([host('h', { providers: [{ providerId: 'codex' } as never] })]);
    expect(() => (s.teams as any).ports.assertHost('h', 'codex')).toThrow('Update the Controller to use Teams.');
  });

  it('refuses a provider the Host does not serve and accepts one it does', () => {
    const s = service([host('h', { teamManagement: true as never, providers: [{ providerId: 'codex' } as never] })]);
    expect(() => (s.teams as any).ports.assertHost('h', 'claude')).toThrow(/unavailable/i);
    expect(() => (s.teams as any).ports.assertHost('h', 'codex')).not.toThrow();
  });

  it('asks for a Controller update before replacing a Team recipient, and again for a generic handoff', () => {
    const none = service([host('h')]);
    expect(() => (none.teams as any).ports.assertRecipientSupport('h')).toThrowError(expect.objectContaining({ code: 'team_recipients_upgrade_required', status: 409 }));
    const recipients = service([host('h', { teamRecipients: 1 as never })]);
    expect(() => (recipients.teams as any).ports.assertRecipientSupport('h')).not.toThrow();
    expect(() => (recipients.teams as any).ports.assertRecipientSupport('h', true)).toThrowError(expect.objectContaining({ code: 'team_succession_upgrade_required', status: 409 }));
    const handoff = service([host('h', { teamRecipients: 1 as never, teamSuccession: 1 as never })]);
    expect(() => (handoff.teams as any).ports.assertRecipientSupport('h', true)).not.toThrow();
  });
});

