import { describe, expect, it } from 'vitest';
import type { Team } from '@orchardworks/agent-remote-protocol';
import type { OpenedSession } from './directory-client.js';
import type { TpmItem } from './hooks/useTpmWork.js';
import type { SessionFork } from './session-forks.js';
import { describeSession } from './session-description.js';

const session = (nativeSessionId: string, extra: Partial<OpenedSession> = {}): OpenedSession & { hostId: string } => ({
  providerId: 'codex', nativeSessionId, agentId: `agent-${nativeSessionId}`, title: nativeSessionId, ...extra, hostId: extra.hostId ?? 'mac',
});
const reference = (extra: Partial<SessionFork> = {}): SessionFork => ({
  id: 'side', mode: 'reference', source: session('main'), target: session('side'), capturedAt: '2026-10-16T00:00:00Z',
  delivery: 'sent', options: {}, settings: [], ...extra,
} as SessionFork);
const tpm = (): TpmItem => ({
  key: 'tpm-work', hostId: 'mac', hostName: 'Mac', online: true, unread: false,
  work: { id: 'work', revision: 1, title: 'Release tracking', providerId: 'codex', mainNativeSessionId: 'main', tpmNativeSessionId: 'tpm',
    phase: 'clarifying', waiting: 'user', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [],
    createdAt: '2026-10-16', updatedAt: '2026-10-16', nextCheckAt: 0 },
});
const team = (): Team => ({
  id: 'release-team', operationId: 'create-team', revision: 1, title: 'Release validation', source: session('main'), status: 'active',
  members: [
    { id: 'leader', role: 'leader', name: 'Coordinator', hostId: 'mac', providerId: 'codex', nativeSessionId: 'leader',
      creation: 'ready', activity: 'idle', responsibility: '', summary: '', updatedAt: 0 },
    { id: 'windows', role: 'member', name: 'Windows validation', hostId: 'windows', providerId: 'copilot', nativeSessionId: 'worker',
      creation: 'ready', activity: 'idle', responsibility: '', summary: '', updatedAt: 0 },
  ], messages: [], createdAt: 0, updatedAt: 0,
});
const rows = (input: Parameters<typeof describeSession>[0]) => describeSession(input).attributions;

describe('session attribution projection', () => {
  it('has no invented relationships for an ordinary or partial session description', () => {
    expect(describeSession({ session: session('ordinary') })).toEqual({
      identity: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'ordinary' }, attributions: [],
    });
    expect(rows({ session: session('worker'), teams: [team()] })).toEqual([]);
  });

  it('keeps Ask ownership on its recorded source after a different view is selected', () => {
    const ask = reference({ id: 'ask', target: session('ask'), source: session('main', { title: 'Original discussion' }) });
    const description = rows({ session: session('ask'), asks: [ask], sessions: [session('other', { title: 'Selected elsewhere' })] });
    expect(description).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'role', value: 'Ask' }),
      expect.objectContaining({ kind: 'main', value: 'Original discussion', target: expect.objectContaining({ hostId: 'mac', nativeSessionId: 'main' }) }),
    ]));
    expect(description.some(row => row.kind === 'parent')).toBe(false);
  });

  it('distinguishes current Ask main from immutable original context after handoff', () => {
    const ask = reference({ id: 'ask', target: session('ask'), source: session('old'), currentSource: session('new', { providerId: 'claude' }) });
    const description = rows({ session: session('ask'), asks: [ask] });
    expect(description.find(row => row.kind === 'main')?.target).toMatchObject({ nativeSessionId: 'new', providerId: 'claude' });
    expect(description.find(row => row.kind === 'main')?.target).not.toHaveProperty('sessionIntent');
    expect(description.find(row => row.label === 'Original source')?.target).toMatchObject({ nativeSessionId: 'old', providerId: 'codex', sessionIntent: 'history' });
  });

  it('uses exact Host and Provider identity to match records and resolve titles', () => {
    const ask = reference({ id: 'ask', target: session('ask') });
    expect(rows({ session: session('ask', { hostId: 'windows' }), asks: [ask] })).toEqual([]);
    expect(rows({ session: session('ask', { providerId: 'claude' }), asks: [ask] })).toEqual([]);
    const description = rows({ session: session('ask'), asks: [ask], sessions: [
      session('main', { title: 'Correct title' }), session('main', { hostId: 'windows', title: 'Wrong host' }),
      session('main', { providerId: 'claude', title: 'Wrong provider' }),
    ] });
    expect(description.find(row => row.kind === 'main')?.value).toBe('Correct title');
    expect(description.find(row => row.kind === 'main')?.detail).toBeUndefined();
  });

  it('only adds Host and Provider distinctions when needed, preferring readable Host names', () => {
    const member = session('worker', { hostId: 'windows', providerId: 'copilot' });
    const description = rows({ session: member, teams: [team()], hostNames: new Map([['mac', 'Build Mac']]) });
    expect(description.find(row => row.kind === 'main')?.detail).toBe('codex · Build Mac');
    expect(rows({ session: member, teams: [team()] }).find(row => row.kind === 'main')?.detail).toBe('codex · mac');
    expect(rows({ session: session('side'), forks: [reference()] }).find(row => row.label === 'Source')?.detail).toBe('Source reference · Read on demand');
  });

  it('maps remote native provenance through verified installation-to-Host evidence', () => {
    const fork = reference({ remote: true, source: session('new'), nativeSourceRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'old' },
      hostLocator: { hostId: 'mac', controllerId: 'installation' } });
    const description = rows({ session: session('side'), forks: [fork], sessions: [session('old', { title: 'Original main' })] });
    expect(description.find(row => row.label === 'Original source')).toMatchObject({ value: 'Original main', target: { hostId: 'mac', nativeSessionId: 'old', sessionIntent: 'history' } });
    const unresolved = rows({ session: session('side'), forks: [{ ...fork, hostLocator: { hostId: 'mac', controllerId: 'other' } }] });
    expect(unresolved.find(row => row.label === 'Original source')).toMatchObject({ value: 'old' });
    expect(unresolved.find(row => row.label === 'Original source')?.target).toBeUndefined();
  });

  it('retains a Side created from a successor rather than mistaking role origin for its context', () => {
    const fork = reference({ remote: true, source: session('C'),
      nativeSourceRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'B' },
      sourceBinding: { kind: 'primary_role', roleId: 'role', origin: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'A' } },
      hostLocator: { hostId: 'mac', controllerId: 'installation' } });
    const description = rows({ session: session('side'), forks: [fork] });
    expect(description.find(row => row.label === 'Source')?.target).toMatchObject({ nativeSessionId: 'C' });
    expect(description.find(row => row.label === 'Original source')?.target).toMatchObject({ hostId: 'mac', nativeSessionId: 'B', sessionIntent: 'history' });
    expect(description.some(row => row.target?.kind === 'session' && row.target.nativeSessionId === 'A')).toBe(false);
    expect(rows({ session: session('side'), forks: [{ ...fork, nativeSourceRef: undefined }] }).some(row => row.label === 'Original source')).toBe(false);
  });

  it('keeps Side read source, original context and navigation overlay distinct', () => {
    const fork = reference({ source: session('original'), currentSource: session('current'), navigationSource: session('edited') });
    const description = rows({ session: session('side'), forks: [fork] });
    expect(description.find(row => row.label === 'Source')?.target).toMatchObject({ nativeSessionId: 'current' });
    expect(description.find(row => row.label === 'Original source')?.target).toMatchObject({ nativeSessionId: 'original', sessionIntent: 'history' });
    expect(description.find(row => row.label === 'Navigation source')?.target).toMatchObject({ nativeSessionId: 'edited' });
    expect(description.some(row => row.kind === 'parent')).toBe(false);
  });

  it('describes snapshots as captured context without asserting native ancestry', () => {
    const fork: SessionFork = { ...reference(), mode: 'snapshot', boundary: { epoch: 'epoch', seq: 4 }, itemCount: 3, text: 'quoted context' };
    const description = rows({ session: session('side'), forks: [fork] });
    expect(description.find(row => row.label === 'Source')?.target).toMatchObject({ nativeSessionId: 'main', sessionIntent: 'history' });
    expect(description.find(row => row.kind === 'context')).toMatchObject({ value: 'Fixed snapshot', detail: expect.stringContaining('3 items') });
    expect(description.some(row => row.kind === 'parent')).toBe(false);
  });

  it('preserves unlinked Side provenance while removing the reverse navigation relation', () => {
    const fork = reference({ linked: false });
    expect(rows({ session: session('side'), forks: [fork] })).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Source' })]));
    expect(rows({ session: session('main'), forks: [fork] })).toEqual([]);
  });

  it('keeps an edited Side recipient history distinct from its current navigation target', () => {
    const fork = reference({ currentTarget: session('edited-side'), currentSource: session('current-main') });
    const historical = rows({ session: session('side'), forks: [fork] });
    expect(historical.find(row => row.label === 'Source')?.target).toMatchObject({ nativeSessionId: 'main', sessionIntent: 'history' });
    expect(historical.some(row => row.target?.kind === 'session' && row.target.nativeSessionId === 'current-main')).toBe(false);
    const linked = rows({ session: session('current-main'), forks: [fork] });
    expect(linked.find(row => row.kind === 'side')?.target).toMatchObject({ nativeSessionId: 'edited-side' });
  });

  it('uses current TPM main and describes its role origin without claiming original TPM context', () => {
    const item = tpm();
    item.work.mainBinding = { kind: 'primary_role', roleId: 'main-role', origin: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'original' } };
    item.work.mainSessionRef = { controllerId: 'installation', providerId: 'claude', nativeSessionId: 'current' };
    const description = rows({ session: session('tpm'), tpmWorks: [item] });
    expect(description.find(row => row.kind === 'role')?.value).toBe('TPM');
    expect(description.find(row => row.kind === 'main')?.target).toMatchObject({ hostId: 'mac', providerId: 'claude', nativeSessionId: 'current' });
    expect(description.find(row => row.label === 'Role origin')?.target).toMatchObject({ hostId: 'mac', providerId: 'codex', nativeSessionId: 'original', sessionIntent: 'history' });
    expect(description.some(row => row.label === 'Original source')).toBe(false);
  });

  it('keeps fixed Ask, Side and TPM sources exact instead of following later succession', () => {
    const fixed = { kind: 'fixed' as const, source: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'main' } };
    const fork = reference({ sourceBinding: fixed });
    const item = tpm(); item.work.mainBinding = fixed;
    for (const description of [
      rows({ session: session('side'), asks: [fork] }), rows({ session: session('side'), forks: [fork] }),
      rows({ session: session('tpm'), tpmWorks: [item] }),
    ]) {
      expect(description.find(row => row.label === 'Main' || row.label === 'Source')?.target).toMatchObject({
        hostId: 'mac', providerId: 'codex', nativeSessionId: 'main', sessionIntent: 'history',
      });
    }
  });

  it('describes Team leaders and cross-Host members without inventing fork ancestry', () => {
    const group = team();
    const leader = rows({ session: session('leader'), teams: [group] });
    expect(leader.find(row => row.kind === 'role')?.value).toBe('Team leader');
    expect(leader.find(row => row.kind === 'team')?.target).toEqual({ kind: 'group', groupType: 'team', groupId: group.id });
    expect(leader.some(row => row.kind === 'leader' || row.kind === 'parent' || row.kind === 'source')).toBe(false);
    const member = rows({ session: session('worker', { hostId: 'windows', providerId: 'copilot' }), teams: [group] });
    expect(member.find(row => row.kind === 'role')?.value).toBe('Team member');
    expect(member.find(row => row.kind === 'leader')?.target).toMatchObject({ hostId: 'mac', providerId: 'codex', nativeSessionId: 'leader' });
    expect(member.find(row => row.kind === 'main')?.target).toMatchObject({ hostId: 'mac', providerId: 'codex', nativeSessionId: 'main' });
    expect(member.some(row => row.kind === 'parent' || row.kind === 'source')).toBe(false);
  });

  it('retains a known Team seat when its execution locator is unavailable without reassigning historical sessions', () => {
    const group = team();
    group.members = group.members.map(member => ({ ...member, nativeSessionId: undefined }));
    const retained = { ...session('last-known-worker', { hostId: 'windows', providerId: 'copilot' }), teamId: group.id, teamMemberId: 'windows' };
    const description = rows({ session: retained, teams: [group] });
    expect(description.find(row => row.kind === 'role')?.value).toBe('Team member');
    expect(description.find(row => row.kind === 'team')?.target).toEqual({ kind: 'group', groupType: 'team', groupId: group.id });
    expect(description.find(row => row.kind === 'main')?.target).toMatchObject({ nativeSessionId: 'main' });
    expect(description.find(row => row.kind === 'leader')).toMatchObject({ value: 'Coordinator' });
    expect(description.find(row => row.kind === 'leader')?.target).toBeUndefined();
    expect(rows({ session: session('last-known-worker', { hostId: 'windows', providerId: 'copilot' }), teams: [group] })).toEqual([]);
    expect(rows({ session: session('last-known-worker', { hostId: 'windows', providerId: 'copilot' }), sessions: [retained], teams: [group] })).toEqual([]);
    expect(rows({ session: { ...retained, hostId: 'other' }, teams: [group] })).toEqual([]);
    expect(rows({ session: { ...retained, providerId: 'codex' }, teams: [group] })).toEqual([]);
    group.members[1]!.nativeSessionId = 'replacement';
    expect(rows({ session: retained, teams: [group] })).toEqual([]);
  });

  it('only exposes recorded native parents and children within the same Host and Provider', () => {
    const child = session('child', { parentNativeSessionId: undefined });
    const entries = [session('child', { parentNativeSessionId: 'main' }), session('main', { title: 'Native parent' }),
      session('other', { hostId: 'windows', parentNativeSessionId: 'main' }), session('other', { providerId: 'claude', parentNativeSessionId: 'main' })];
    expect(rows({ session: child, sessions: entries }).find(row => row.kind === 'parent')).toMatchObject({ value: 'Native parent', target: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'main' } });
    expect(rows({ session: session('main'), sessions: entries }).filter(row => row.kind === 'child')).toHaveLength(1);
    expect(rows({ session: session('self', { parentNativeSessionId: 'self' }) })).toEqual([]);
  });

  it('retains multiple distinct relationships and known reverse links without duplicates', () => {
    const side = reference();
    const ask = reference({ id: 'ask', target: session('ask') });
    const input = { session: session('main'), forks: [side, side], asks: [ask], tpmWorks: [tpm()], teams: [team()],
      sessions: [session('child', { parentNativeSessionId: 'main' })] };
    const before = structuredClone(input);
    const description = rows(input);
    expect(description.map(row => row.kind)).toEqual(expect.arrayContaining(['side', 'ask', 'tpm', 'team', 'team-leader', 'child']));
    expect(description.filter(row => row.kind === 'side')).toHaveLength(1);
    expect(new Set(description.map(row => row.id)).size).toBe(description.length);
    expect(input).toEqual(before);
    const combined = rows({ session: session('side', { parentNativeSessionId: 'native-parent' }), forks: [side], asks: [reference({ id: 'ask', target: session('side') })] });
    expect(combined.filter(row => row.kind === 'role').map(row => row.value)).toEqual(['Ask', 'Side']);
    expect(combined.some(row => row.kind === 'parent')).toBe(true);
  });
});
