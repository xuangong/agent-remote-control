import { describe, expect, it } from 'vitest';
import { createBrokerState } from './broker-state.js';
import type { Host, RemoteHostBrokerState } from './broker-types.js';
import { emptyCallForSupportState } from './call-for-support-profiles.js';
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

describe('callForSupportChange', () => {
  it('commits a changed state once and hands back what the change returned', async () => {
    const s = service();
    const value = await s.callForSupportChange(state => { state.enablement.push({ hostId: 'h', providerId: 'codex', nativeSessionId: 'n', profileIds: [], updatedAt: 5 }); return 'changed'; });
    expect(value).toBe('changed');
    expect(s.saves).toHaveLength(1);
    expect(s.brokerState.callForSupport?.enablement).toHaveLength(1);
  });

  it('commits nothing for a change that leaves the state as it was', async () => {
    const s = service();
    expect(await s.callForSupportChange(() => 7)).toBe(7);
    expect(s.saves).toEqual([]);
    expect(s.brokerState.callForSupport ?? emptyCallForSupportState()).toEqual(emptyCallForSupportState());
  });

  it('refuses a state that is not valid and keeps the old one', async () => {
    const s = service();
    await expect(s.callForSupportChange(state => { state.profiles.push({ id: 'not a profile' } as never); })).rejects.toThrow('Invalid Call For Support state.');
    expect(s.saves).toEqual([]);
    expect(s.brokerState.callForSupport?.profiles ?? []).toEqual([]);
  });

  it('does not let the caller change the committed state afterwards through what it returned', async () => {
    const s = service();
    const entry = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', profileIds: [], updatedAt: 5 };
    const returned = await s.callForSupportChange(state => { state.enablement.push(entry); return state.enablement; });
    returned.push({ ...entry, nativeSessionId: 'other' });
    expect(s.brokerState.callForSupport?.enablement).toHaveLength(1);
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

describe('Call For Support on a Host', () => {
  it('is capable only on a Host that announced it, and refuses with the update words otherwise', () => {
    const s = service([host('on', { callForSupport: 1 as never }), host('off')]);
    const ports = (s.teams as any).ports.callForSupport;
    expect(ports.capable('on')).toBe(true); expect(ports.capable('off')).toBe(false); expect(ports.capable('missing')).toBe(false);
    expect(() => ports.assertHost('on')).not.toThrow();
    expect(() => ports.assertHost('off')).toThrowError(expect.objectContaining({ code: 'call_for_support_upgrade_required' }));
  });

  it('is read-only for a provider the Host marked read-only, and only while that provider is served', () => {
    const s = service([host('h', { callForSupport: 1 as never, readOnlyProviders: ['codex', 'gone'] as never, providers: [{ providerId: 'codex' } as never] })]);
    const ports = (s.teams as any).ports.callForSupport;
    expect(ports.readOnly('h', 'codex')).toBe(true); expect(ports.readOnly('h', 'gone')).toBe(false); expect(ports.readOnly('h', 'claude')).toBe(false);
  });

  it('reports the message the Host gave when a supporter patch or a bundle fails', async () => {
    const s = service([host('h')], { status: 500, body: '{"error":"no room"}' });
    const ports = (s.teams as any).ports.callForSupport;
    await expect(ports.supportPatch('h', {})).rejects.toThrow('no room');
    await expect(ports.supportBundle('h', {})).rejects.toThrow('no room');
  });

  it('forwards a supporter patch and a bundle to the Host', async () => {
    const s = service([host('h')]);
    const ports = (s.teams as any).ports.callForSupport;
    await ports.supportPatch('h', { a: 1 }); await ports.supportBundle('h', { b: 2 });
    expect(s.calls).toEqual([{ path: '/remote/team/support-patch', body: '{"a":1}' }, { path: '/remote/team/support-bundle', body: '{"b":2}' }]);
  });
});
