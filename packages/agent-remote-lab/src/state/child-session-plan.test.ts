// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { besideChildSession, childOpensBeside, childRequestCurrent, directParentOf, knownChildOf, replacingChildSession } from './child-session-plan.js';

const origin = { agentId: 'a-parent', providerId: 'codex', nativeSessionId: 'parent', hostId: 'h1' };
const child = { nativeSessionId: 'child', title: 'Child', createdAt: '2026-01-01T00:00:00.000Z' };

describe('where a child session opens', () => {
  it('beside its parent with a shared Window, or on a desktop layout', () => {
    expect(childOpensBeside({ sharedWindow: true, compact: true })).toBe(true);
    expect(childOpensBeside({ sharedWindow: false, compact: false })).toBe(true);
  });
  it('in place of the shown session on a compact layout without a shared Window', () => {
    expect(childOpensBeside({ sharedWindow: false, compact: true })).toBe(false);
  });
});

describe('finding the child the directory knows', () => {
  const entries = [
    { nativeSessionId: 'child', providerId: 'claude', hostId: 'h1', parentNativeSessionId: 'x' },
    { nativeSessionId: 'child', providerId: 'codex', hostId: 'h2', parentNativeSessionId: 'y' },
    { nativeSessionId: 'child', providerId: 'codex', hostId: 'h1', parentNativeSessionId: 'z' },
  ];
  it('matches the native id on the origin provider and Host', () => {
    expect(knownChildOf(entries, 'child', origin)?.parentNativeSessionId).toBe('z');
    expect(knownChildOf(entries, 'other', origin)).toBeUndefined();
  });
  it('treats a missing Host as local', () => {
    expect(knownChildOf([{ nativeSessionId: 'c', providerId: 'codex', parentNativeSessionId: 'p' }], 'c', { ...origin, hostId: undefined })?.parentNativeSessionId).toBe('p');
    expect(knownChildOf([{ nativeSessionId: 'c', providerId: 'codex', parentNativeSessionId: 'p' }], 'c', origin)).toBeUndefined();
  });
});

describe('the session a child opens from', () => {
  const grand = { ...origin, agentId: 'a-direct', nativeSessionId: 'direct' };
  it('stays the shown session when the child has no recorded parent, or the shown session is its parent', () => {
    expect(directParentOf(origin, undefined, [grand])).toBe(origin);
    expect(directParentOf(origin, { providerId: 'codex', nativeSessionId: 'child' }, [grand])).toBe(origin);
    expect(directParentOf(origin, { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'parent' }, [grand])).toBe(origin);
  });
  it('is the open direct parent of a nested child', () => {
    expect(directParentOf(origin, { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'direct' }, [origin, grand])).toBe(grand);
  });
  it('does not take a session of another provider or Host for the direct parent', () => {
    const known = { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'direct' };
    expect(() => directParentOf(origin, known, [{ ...grand, providerId: 'claude' }])).toThrow('Open the direct parent session');
    expect(() => directParentOf(origin, known, [{ ...grand, hostId: 'h2' }])).toThrow('Open the direct parent session');
  });
  it('refuses a nested child whose direct parent is not open', () => {
    expect(() => directParentOf(origin, { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'direct' }, [origin]))
      .toThrow('Open the direct parent session before opening this nested subagent.');
  });
});

describe('the opened child', () => {
  it('beside: keeps the child, takes the origin provider and Host, and names the origin as parent', () => {
    expect(besideChildSession(child, origin, 'a-child')).toEqual({ ...child, agentId: 'a-child', providerId: 'codex', hostId: 'h1', parentAgentId: 'a-parent', parentNativeSessionId: 'parent' });
  });
  it('replacing: takes the Host\'s native id and the recorded parent', () => {
    const known = { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'direct', parentAgentId: 'a-direct' };
    expect(replacingChildSession(child, origin, known, { agentId: 'a-child', nativeSessionId: 'native-child' })).toEqual({
      agentId: 'a-child', providerId: 'codex', nativeSessionId: 'native-child', title: 'Child', createdAt: child.createdAt, hostId: 'h1',
      parentAgentId: 'a-direct', parentNativeSessionId: 'direct' });
  });
  it('replacing: falls back to the origin as parent and to the local Host', () => {
    const opened = replacingChildSession(child, { ...origin, hostId: undefined }, undefined, { agentId: 'a-child', nativeSessionId: 'native-child' });
    expect(opened).toMatchObject({ hostId: 'local', parentAgentId: 'a-parent', parentNativeSessionId: 'parent' });
  });
  it('replacing: keeps the recorded parent native id without a recorded parent agent', () => {
    const opened = replacingChildSession(child, origin, { providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'direct' }, { agentId: 'a', nativeSessionId: 'n' });
    expect(opened).toMatchObject({ parentNativeSessionId: 'direct', parentAgentId: 'a-parent' });
  });
});

describe('an answer that arrives late', () => {
  it('is used in the generation it started in', () => expect(childRequestCurrent({ generation: 3 }, 3)).toBe(true));
  it('is dropped after the workspace changed', () => expect(childRequestCurrent({ generation: 3 }, 4)).toBe(false));
  it('is dropped when a later Side request of the same source superseded it', () => {
    expect(childRequestCurrent({ generation: 3, side: { issued: 1, latest: 1 } }, 3)).toBe(true);
    expect(childRequestCurrent({ generation: 3, side: { issued: 1, latest: 2 } }, 3)).toBe(false);
    expect(childRequestCurrent({ generation: 3, side: { issued: 1, latest: 1 } }, 4)).toBe(false);
  });
});
