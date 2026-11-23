import { describe, expect, it } from 'vitest';
import type { OpenedSession } from './directory-client.js';
import type { SessionFork } from './session-forks.js';
import { describeSession } from './session-description.js';

const session = (nativeSessionId: string, extra: Partial<OpenedSession> = {}): OpenedSession & { hostId: string } => ({
  providerId: 'codex', nativeSessionId, agentId: `agent-${nativeSessionId}`, title: nativeSessionId, ...extra, hostId: extra.hostId ?? 'mac',
});
const reference = (extra: Partial<SessionFork> = {}): SessionFork => ({
  id: 'side', mode: 'reference', source: session('main'), target: session('side'), capturedAt: '2026-10-16T00:00:00Z',
  delivery: 'sent', options: {}, settings: [], ...extra,
} as SessionFork);
const rows = (input: Parameters<typeof describeSession>[0]) => describeSession(input).attributions;

describe('session attribution projection', () => {
  it('has no invented relationships for an ordinary or partial session description', () => {
    expect(describeSession({ session: session('ordinary') })).toEqual({
      identity: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'ordinary' }, attributions: [],
    });
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

  it('describes a Side\'s source reference', () => {
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

  it('keeps fixed Ask and Side sources exact instead of following later succession', () => {
    const fixed = { kind: 'fixed' as const, source: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'main' } };
    const fork = reference({ sourceBinding: fixed });
    for (const description of [
      rows({ session: session('side'), asks: [fork] }), rows({ session: session('side'), forks: [fork] }),
    ]) {
      expect(description.find(row => row.label === 'Main' || row.label === 'Source')?.target).toMatchObject({
        hostId: 'mac', providerId: 'codex', nativeSessionId: 'main', sessionIntent: 'history',
      });
    }
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
    const input = { session: session('main'), forks: [side, side], asks: [ask],
      sessions: [session('child', { parentNativeSessionId: 'main' })] };
    const before = structuredClone(input);
    const description = rows(input);
    expect(description.map(row => row.kind)).toEqual(expect.arrayContaining(['side', 'ask', 'child']));
    expect(description.filter(row => row.kind === 'side')).toHaveLength(1);
    expect(new Set(description.map(row => row.id)).size).toBe(description.length);
    expect(input).toEqual(before);
    const combined = rows({ session: session('side', { parentNativeSessionId: 'native-parent' }), forks: [side], asks: [reference({ id: 'ask', target: session('side') })] });
    expect(combined.filter(row => row.kind === 'role').map(row => row.value)).toEqual(['Ask', 'Side']);
    expect(combined.some(row => row.kind === 'parent')).toBe(true);
  });

  it('merges duplicate related Ask destinations without discarding distinct conversations', () => {
    const first = session('01a0-first-12345678', { title: 'Ask' });
    const second = session('01a0-next-87654321', { title: 'Ask' });
    const description = rows({ session: session('main'), asks: [
      reference({ id: 'local', target: first }), reference({ id: 'shared', relationId: 'server', target: first }),
      reference({ id: 'other', target: second }),
    ] });
    expect(description).toHaveLength(2);
    expect(description.map(row => row.value)).toEqual(['Ask · 12345678', 'Ask · 87654321']);
    expect(description.map(row => row.target)).toEqual([
      expect.objectContaining({ nativeSessionId: first.nativeSessionId }),
      expect.objectContaining({ nativeSessionId: second.nativeSessionId }),
    ]);
  });

  it('prefers known related titles and distinguishes genuine conversations with the same title', () => {
    const first = session('first-12345678', { title: 'Ask' });
    const second = session('second-87654321', { title: 'Ask' });
    const asks = [reference({ id: 'first', target: first }), reference({ id: 'second', target: second })];
    const sessions = [{ ...first, title: 'Release questions' }, { ...second, title: 'Platform questions' }];
    expect(rows({ session: session('main'), asks, sessions }).map(row => row.value))
      .toEqual(['Release questions', 'Platform questions']);
    expect(rows({ session: session('main'), asks, sessions: sessions.map(item => ({ ...item, title: 'Discussion' })) })
      .map(row => row.value)).toEqual(['Discussion · 12345678', 'Discussion · 87654321']);
  });

  it('uses enough of the native identity to disambiguate colliding related session suffixes', () => {
    const description = rows({ session: session('main'), asks: [
      reference({ id: 'first', target: session('first-a12345678', { title: 'Ask' }) }),
      reference({ id: 'second', target: session('second-b12345678', { title: 'Ask' }) }),
    ] });
    expect(description.map(row => row.value)).toEqual(['Ask · a12345678', 'Ask · b12345678']);
  });

  it('keeps related targets in different scopes and different relationship kinds distinct', () => {
    const target = session('12345678', { title: 'Ask' });
    const description = rows({ session: session('main'), asks: [reference({ id: 'first', target }),
      reference({ id: 'remote', target: { ...target, hostId: 'windows' } }),
      reference({ id: 'provider', target: { ...target, providerId: 'claude' } })],
    forks: [reference({ id: 'side', target })] });
    expect(description.filter(row => row.kind === 'ask')).toHaveLength(3);
    expect(description.filter(row => row.kind === 'side')).toHaveLength(1);
    expect(description.filter(row => row.kind === 'ask').map(row => row.detail)).toEqual([undefined, 'windows', 'claude']);
  });
});
