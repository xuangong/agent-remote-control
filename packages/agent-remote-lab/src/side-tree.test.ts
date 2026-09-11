import { expect, it } from 'vitest';
import type { OpenedSession } from './directory-client.js';
import { sessionKey } from './session-tree.js';
import { expandedSideRange, sidePath } from './side-tree.js';

const node = (nativeSessionId: string, hostId = 'local'): OpenedSession => ({ nativeSessionId, agentId: nativeSessionId, title: nativeSessionId, providerId: 'recorded', hostId });
const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)) as [OpenedSession, OpenedSession, OpenedSession, OpenedSession, OpenedSession];
const branches = { [sessionKey(a)]: sessionKey(b), [sessionKey(b)]: sessionKey(d), [sessionKey(c)]: sessionKey(e) };

it('restores each sibling route without replacing its descendant selection', () => {
  expect(sidePath(a, [b, c, d, e], branches)).toEqual([a, b, d]);
  expect(sidePath(a, [b, c, d, e], { ...branches, [sessionKey(a)]: sessionKey(c) })).toEqual([a, c, e]);
  expect(sidePath(a, [b, c, d, e], branches)).toEqual([a, b, d]);
});
it('closing an edge leaves descendant routes available for reopening', () => {
  expect(sidePath(a, [b, d], { ...branches, [sessionKey(a)]: null })).toEqual([a]);
  expect(sidePath(a, [b, d], branches)).toEqual([a, b, d]);
});
it('bounds broken, cyclic and cross-host paths by complete session identity', () => {
  expect(sidePath(a, [b], branches)).toEqual([a, b]);
  expect(sidePath(a, [a, b], { [sessionKey(a)]: sessionKey(b), [sessionKey(b)]: sessionKey(a) })).toEqual([a, b]);
  expect(sidePath(a, [node('b', 'other')], branches)).toEqual([a]);
});
it('expands the latest pair or an earlier window without deleting the rest of the path', () => {
  const path = [a, b, d];
  expect(expandedSideRange(path, undefined, 2)).toEqual({ start: 1, end: 2 });
  expect(expandedSideRange(path, sessionKey(b), 2)).toEqual({ start: 0, end: 1 });
  expect(expandedSideRange(path, sessionKey(a), 2)).toEqual({ start: 0, end: 0 });
  expect(expandedSideRange(path, undefined, 1)).toEqual({ start: 2, end: 2 });
  expect(expandedSideRange(path, 'unavailable', 2)).toEqual({ start: 1, end: 2 });
});
