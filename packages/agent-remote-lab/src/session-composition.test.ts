// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearConversationRecovery } from './conversation-recovery.js';
import { readSessionComposition, saveSessionComposition, type SessionComposition } from './session-composition.js';
import type { OpenedSession } from './directory-client.js';

const source: OpenedSession = { hostId: 'desk', providerId: 'codex', nativeSessionId: 'main', agentId: 'old-main-binding', title: 'Main' };
const side: OpenedSession = { ...source, nativeSessionId: 'side', agentId: 'old-side-binding', title: 'Side' };
const sourceKey = '["desk","codex","main"]';
const sideKey = '["desk","codex","side"]';
const storageKey = (scope: string) => `agent-remote:recovery:${scope}:composition`;
const composition = (): SessionComposition => ({ path: [source, side], focus: sideKey, anchor: sideKey, addressKey: sideKey });

afterEach(() => {
  vi.restoreAllMocks();
  clearConversationRecovery();
  sessionStorage.clear(); localStorage.clear();
});

it('restores the saved side address and preserves old bindings only as metadata', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', side)).toEqual({
    path: [source, side], focus: sideKey, anchor: sideKey, addressKey: sideKey,
  });
  expect(localStorage.getItem(storageKey('alice'))).toBeNull();
});

it('does not replace another explicit link or another workspace with the saved composition', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', { ...side, nativeSessionId: 'other' })).toBeUndefined();
  expect(readSessionComposition('bob', side)).toBeUndefined();
  expect(readSessionComposition('alice', undefined)).toBeUndefined();
  expect(readSessionComposition('alice', { hostId: 'desk', providerId: 'codex' })).toBeUndefined();
});

it('replaces the full path after the side is closed instead of reviving its old selection', () => {
  saveSessionComposition('alice', composition());
  saveSessionComposition('alice', { path: [source], focus: sourceKey, anchor: sourceKey, addressKey: sourceKey });
  expect(readSessionComposition('alice', source)).toEqual({ path: [source], focus: sourceKey, anchor: sourceKey, addressKey: sourceKey });
  expect(readSessionComposition('alice', side)).toBeUndefined();
});

it('keeps Host and Provider identity separate even when native IDs and old bindings match', () => {
  const otherHost = { ...source, hostId: 'laptop' };
  saveSessionComposition('alice', { path: [source, otherHost], addressKey: '["laptop","codex","main"]' });
  expect(readSessionComposition('alice', otherHost)?.path).toEqual([source, otherHost]);
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', { ...otherHost, providerId: 'claude' })).toBeUndefined();
});

it('keeps sessions from different Providers distinct within a saved path', () => {
  const otherProvider = { ...source, providerId: 'claude' };
  saveSessionComposition('alice', { path: [source, otherProvider], addressKey: '["desk","claude","main"]' });
  expect(readSessionComposition('alice', otherProvider)?.path).toEqual([source, otherProvider]);
});

it('normalizes an omitted local Host only for identity matching', () => {
  const local = { providerId: 'codex', nativeSessionId: 'main', agentId: 'old-local-binding', title: 'Local' };
  saveSessionComposition('alice', { path: [local], addressKey: '["local","codex","main"]' });
  expect(readSessionComposition('alice', { ...local, hostId: 'local' })?.path).toEqual([local]);
});

it('persists only session metadata and snapshots it before the queued write', () => {
  const entry = { ...source, parentAgentId: 'old-parent-binding', parentNativeSessionId: 'parent', createdAt: '2026-10-08T00:00:00Z', secret: 'discard', timeline: ['discard'] };
  const value = { path: [entry], addressKey: sourceKey, draft: 'discard' };
  saveSessionComposition('alice', value);
  entry.title = 'Changed after saving';
  const restored = readSessionComposition('alice', source);
  expect(restored).toEqual({ path: [{ ...source, parentAgentId: 'old-parent-binding', parentNativeSessionId: 'parent', createdAt: '2026-10-08T00:00:00Z' }], addressKey: sourceKey });
  expect(sessionStorage.getItem(storageKey('alice'))).not.toContain('discard');
});

it('does not expose extra fields from an otherwise valid stored composition', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify({ path: [{ ...source, secret: 'discard', timeline: ['discard'] }], addressKey: sourceKey, draft: 'discard' }));
  expect(readSessionComposition('alice', source)).toEqual({ path: [source], addressKey: sourceKey });
});

it.each([
  ['invalid JSON', '{'],
  ['non-object', 'null'],
  ['missing path', JSON.stringify({ addressKey: sourceKey })],
  ['non-array path', JSON.stringify({ path: source, addressKey: sourceKey })],
  ['empty path', JSON.stringify({ path: [], addressKey: sourceKey })],
  ['null session', JSON.stringify({ path: [null], addressKey: sourceKey })],
  ['invalid binding metadata', JSON.stringify({ path: [{ ...source, agentId: false }], addressKey: sourceKey })],
  ['invalid title metadata', JSON.stringify({ path: [{ ...source, title: [] }], addressKey: sourceKey })],
  ['empty Provider identity', JSON.stringify({ path: [{ ...source, providerId: '' }], addressKey: sourceKey })],
  ['missing native identity', JSON.stringify({ path: [{ ...source, nativeSessionId: undefined }], addressKey: sourceKey })],
  ['empty native identity', JSON.stringify({ path: [{ ...source, nativeSessionId: '' }], addressKey: sourceKey })],
  ['invalid Host', JSON.stringify({ path: [{ ...source, hostId: 3 }], addressKey: sourceKey })],
  ['invalid optional metadata', JSON.stringify({ path: [{ ...source, parentNativeSessionId: false }], addressKey: sourceKey })],
  ['repeated native identity', JSON.stringify({ path: [source, { ...source, agentId: 'new-binding' }], addressKey: sourceKey })],
  ['cyclic selected path', JSON.stringify({ path: [source, side, source], addressKey: sideKey })],
  ['focus outside the path', JSON.stringify({ ...composition(), focus: 'another-session' })],
  ['anchor outside the path', JSON.stringify({ ...composition(), anchor: 'another-session' })],
  ['address outside the path', JSON.stringify({ path: [source], addressKey: sideKey })],
])('ignores corrupt composition data: %s', (_name, saved) => {
  sessionStorage.setItem(storageKey('alice'), saved);
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', side)).toBeUndefined();
});

it('accepts a bounded path and rejects an oversized saved path', () => {
  const path = Array.from({ length: 100 }, (_, index) => ({ ...source, nativeSessionId: `session-${index}` }));
  saveSessionComposition('alice', { path, addressKey: '["desk","codex","session-0"]' });
  expect(readSessionComposition('alice', path[0])?.path).toHaveLength(100);
  sessionStorage.setItem(storageKey('alice'), JSON.stringify({ path: [...path, side], addressKey: '["desk","codex","session-0"]' }));
  expect(readSessionComposition('alice', path[0])).toBeUndefined();
});

it('clears stored and queued compositions only for the signed-out workspace', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', side)).toBeDefined();
  saveSessionComposition('alice', { path: [source], addressKey: sourceKey });
  saveSessionComposition('bob', composition());
  sessionStorage.setItem('unrelated', 'keep');
  clearConversationRecovery('alice');
  window.dispatchEvent(new Event('pagehide'));
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', side)).toBeUndefined();
  expect(readSessionComposition('bob', side)).toBeDefined();
  expect(sessionStorage.getItem('unrelated')).toBe('keep');
});

it('leaves ordinary session navigation usable when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  expect(() => saveSessionComposition('alice', composition())).not.toThrow();
  expect(readSessionComposition('alice', side)).toBeUndefined();
  expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
});
