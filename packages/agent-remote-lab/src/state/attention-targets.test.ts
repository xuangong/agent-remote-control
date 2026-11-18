// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { attentionDestination, attentionSets, botDirectorySources, keySignature, readableSessions } from './attention-targets.js';

const facts = (overrides: Partial<Parameters<typeof attentionSets<string, string, string, string>>[0]> = {}) => ({
  enabled: true, windowMode: true, tracked: ['t1'], openWindows: ['w1', 'w2'], askSessions: ['a1'], botTargets: ['b1', 'b2'], ...overrides,
});

describe('the sessions attention watches', () => {
  it('watches nothing while attention is off', () => {
    expect(attentionSets(facts({ enabled: false }))).toEqual({ eligible: [], displayed: [] });
  });
  it('watches tracked, open and Ask sessions in Window mode, and shows the open and Ask ones', () => {
    expect(attentionSets(facts())).toEqual({ eligible: ['t1', 'w1', 'w2', 'a1'], displayed: ['w1', 'w2', 'a1'] });
  });
  it('watches and shows the bots in Bot mode', () => {
    expect(attentionSets(facts({ windowMode: false }))).toEqual({ eligible: ['b1', 'b2'], displayed: ['b1', 'b2'] });
  });
});

describe('the key signature of a set of sessions', () => {
  const key = (session: { id: string }) => session.id;
  it('does not depend on order or duplicates', () => {
    expect(keySignature([{ id: 'b' }, { id: 'a' }, { id: 'b' }], key)).toBe(keySignature([{ id: 'a' }, { id: 'b' }], key));
  });
  it('changes when the set changes', () => {
    expect(keySignature([{ id: 'a' }], key)).not.toBe(keySignature([{ id: 'a' }, { id: 'b' }], key));
  });
  it('is sorted JSON', () => expect(keySignature([{ id: 'b' }, { id: 'a' }], key)).toBe('["a","b"]'));
});

describe('the sessions a person is reading', () => {
  const base = { windowMode: true, visibleWindows: ['w1'], visibleBots: ['b1', 'b2'], botSession: 'sel', earlier: () => ['e1'] };
  it('is the visible Windows in Window mode, without reading the earlier sessions', () => {
    let read = false;
    expect(readableSessions({ ...base, earlier: () => { read = true; return []; } })).toEqual(['w1']);
    expect(read).toBe(false);
  });
  it('is the visible bots, the selected bot and the sessions before its handoff in Bot mode', () => {
    expect(readableSessions({ ...base, windowMode: false })).toEqual(['b1', 'b2', 'sel', 'e1']);
  });
  it('is empty in Bot mode with no visible bot or no selected bot', () => {
    expect(readableSessions({ ...base, windowMode: false, visibleBots: [] })).toEqual([]);
    expect(readableSessions({ ...base, windowMode: false, botSession: undefined })).toEqual([]);
  });
});

describe('where a notification leads', () => {
  const lookups = (overrides: Partial<Parameters<typeof attentionDestination<string>>[1]> = {}) => ({
    windowMode: true, eligibleKeys: new Set(['k-b']), openWindows: ['s1', 's2'], keyOf: (session: string) => `k-${session}`,
    askTargetKey: (source: string) => source === 's2' ? 'k-asked' : undefined, ...overrides,
  });
  it('ignores a session that is not eligible in Bot mode, and shows the row of one that is', () => {
    expect(attentionDestination('k-x', lookups({ windowMode: false }))).toEqual({ kind: 'ignore' });
    expect(attentionDestination('k-b', lookups({ windowMode: false }))).toEqual({ kind: 'bot-row' });
  });
  it('reveals the open Window that shows the session', () => {
    expect(attentionDestination('k-s1', lookups())).toEqual({ kind: 'reveal', session: 's1' });
  });
  it('prefers the Window that shows the session over an Ask with it', () => {
    expect(attentionDestination('k-s2', lookups({ askTargetKey: () => 'k-s2' }))).toEqual({ kind: 'reveal', session: 's2' });
  });
  it('opens the Ask of the Window whose Ask conversation is the session', () => {
    expect(attentionDestination('k-asked', lookups())).toEqual({ kind: 'ask', source: 's2' });
  });
  it('opens any other session as history', () => {
    expect(attentionDestination('k-else', lookups())).toEqual({ kind: 'open-history' });
  });
  it('does not consult the eligible keys in Window mode', () => {
    expect(attentionDestination('k-else', lookups({ eligibleKeys: new Set() }))).toEqual({ kind: 'open-history' });
  });
});

describe('where Bot mode finds sessions that are not bots', () => {
  const hosts = [
    { id: 'h1', online: true, providers: [{ providerId: 'claude' }, { providerId: 'codex' }] },
    { id: 'h2', online: false, providers: [{ providerId: 'claude' }] },
    { id: 'h3', online: true },
  ];
  const built = (overrides: Partial<Parameters<typeof botDirectorySources<string>>[0]> = {}) => botDirectorySources<string>({
    localProviders: [{ providerId: 'codex' }], selectedHostId: 'h1', selectedDirectory: 'selected', hosts, directoryFor: hostId => `made-${hostId}`, ...overrides,
  });
  it('lists each Host provider, with the selected Host on its own client and the others on a made one', () => {
    expect(built().map(source => [source.id, source.directory, source.online])).toEqual([['h1/claude', 'selected', true], ['h1/codex', 'selected', true], ['h2/claude', 'made-h2', false]]);
  });
  it('lists the local providers first while the local Host is selected', () => {
    expect(built({ selectedHostId: 'local' }).map(source => source.id)).toEqual(['local/codex', 'h1/claude', 'h1/codex', 'h2/claude']);
    expect(built({ selectedHostId: 'local' })[0]).toMatchObject({ hostId: 'local', directory: 'selected', online: true });
  });
  it('lists no local provider when another Host is selected, none are loaded, or there is no directory', () => {
    expect(built().some(source => source.hostId === 'local')).toBe(false);
    expect(built({ selectedHostId: 'local', localProviders: [] }).some(source => source.hostId === 'local')).toBe(false);
    expect(built({ selectedHostId: 'local', selectedDirectory: undefined }).some(source => source.hostId === 'local')).toBe(false);
  });
  it('makes a client for the selected Host while there is no directory', () => {
    expect(built({ selectedDirectory: undefined }).find(source => source.id === 'h1/claude')?.directory).toBe('made-h1');
  });
  it('lists a source id once, where it first appeared, as last described', () => {
    const result = built({ selectedHostId: 'local', hosts: [{ id: 'local', online: false, providers: [{ providerId: 'codex' }] }, { id: 'h2', online: true, providers: [{ providerId: 'x' }] }] });
    expect(result.map(source => [source.id, source.online])).toEqual([['local/codex', false], ['h2/x', true]]);
  });
});
