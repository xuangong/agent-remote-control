import { describe, expect, it } from 'vitest';
import { sessionForest, sessionChildren, type SessionEntry } from './session-tree.js';
const entry = (nativeSessionId: string, parentNativeSessionId?: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({ nativeSessionId, parentNativeSessionId, providerId: 'codex', title: nativeSessionId, ...extra });
describe('sessionForest', () => {
  it('groups nested children by native identity and creation time while preserving root order', () => {
    const roots = sessionForest([entry('root'), entry('late', 'root', { createdAt: '2026-09-10' }), entry('other'), entry('early', 'root', { createdAt: '2026-09-09' }), entry('nested', 'early')]);
    expect(roots.map((node) => node.session.title)).toEqual(['root', 'other']);
    expect(roots[0]!.children.map((node) => node.session.title)).toEqual(['early', 'late']);
    expect(roots[0]!.children[0]!.children[0]!.session.title).toBe('nested');
  });
  it('retains closed parents and isolates identical native ids by host and provider', () => {
    const roots = sessionForest([entry('child', 'parent'), entry('parent', undefined, { hostId: 'remote' }), entry('parent', undefined, { providerId: 'dsh' })], [entry('parent', 'grandparent'), entry('grandparent')]);
    expect(roots).toHaveLength(3);
    const local = roots.find((node) => node.session.nativeSessionId === 'grandparent')!;
    expect(local.placeholder).toBe(true);
    expect(local.children[0]!.children[0]!.session.title).toBe('child');
    expect(roots.filter((node) => node.session.nativeSessionId === 'parent').every((node) => !node.children.length)).toBe(true);
  });
  it('keeps malformed cycles visible without recursively following them', () => {
    expect(sessionForest([entry('a', 'b'), entry('b', 'a'), entry('self', 'self')])).toHaveLength(3);
  });
});

it('resolves descendants from recorded identity without mixing Hosts or Providers or inventing status', () => {
  const entries = [entry('review', 'parent'), entry('nested', 'review'), entry('foreign', 'review', { hostId: 'remote' }), entry('foreign-provider', 'review', { providerId: 'claude' })];
  expect(sessionChildren(entry('review'), entries)).toEqual([entry('nested', 'review')]);
  expect(sessionChildren(entry('review'), entries)[0]?.status).toBeUndefined();
});
