import { expect, it } from 'vitest';
import type { OpenedSession } from './directory-client.js';
import { expandedSideRange, sidePath } from './side-tree.js';

type ViewSession = OpenedSession & { viewId: string };
const node = (nativeSessionId: string, hostId = 'local', viewId = `${hostId}:${nativeSessionId}`): ViewSession => ({ viewId, nativeSessionId, agentId: nativeSessionId, title: nativeSessionId, providerId: 'recorded', hostId });
const viewKey = (session: OpenedSession) => (session as ViewSession).viewId;
const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)) as [ViewSession, ViewSession, ViewSession, ViewSession, ViewSession];
const branches = { [viewKey(a)]: viewKey(b), [viewKey(b)]: viewKey(d), [viewKey(c)]: viewKey(e) };

it('restores each sibling route without replacing its descendant selection', () => {
  expect(sidePath(a, [b, c, d, e], branches, viewKey)).toEqual([a, b, d]);
  expect(sidePath(a, [b, c, d, e], { ...branches, [viewKey(a)]: viewKey(c) }, viewKey)).toEqual([a, c, e]);
  expect(sidePath(a, [b, c, d, e], branches, viewKey)).toEqual([a, b, d]);
});
it('closing an edge leaves descendant routes available for reopening', () => {
  expect(sidePath(a, [b, d], { ...branches, [viewKey(a)]: null }, viewKey)).toEqual([a]);
  expect(sidePath(a, [b, d], branches, viewKey)).toEqual([a, b, d]);
});
it('bounds broken, cyclic and cross-host paths by explicit view identity', () => {
  expect(sidePath(a, [b], branches, viewKey)).toEqual([a, b]);
  expect(sidePath(a, [a, b], { [viewKey(a)]: viewKey(b), [viewKey(b)]: viewKey(a) }, viewKey)).toEqual([a, b]);
  expect(sidePath(a, [node('b', 'other')], branches, viewKey)).toEqual([a]);
});
it('expands the latest pair or an earlier window without deleting the rest of the path', () => {
  const path = [a, b, d];
  expect(expandedSideRange(path, undefined, 2, viewKey)).toEqual({ start: 1, end: 2 });
  expect(expandedSideRange(path, viewKey(b), 2, viewKey)).toEqual({ start: 0, end: 1 });
  expect(expandedSideRange(path, viewKey(a), 2, viewKey)).toEqual({ start: 0, end: 0 });
  expect(expandedSideRange(path, undefined, 1, viewKey)).toEqual({ start: 2, end: 2 });
  expect(expandedSideRange(path, 'unavailable', 2, viewKey)).toEqual({ start: 1, end: 2 });
});

it('keeps independent windows of one native session in their own route and focus', () => {
  const primary = node('same', 'local', 'primary'), independent = node('same', 'local', 'independent');
  const path = sidePath(primary, [independent], { primary: 'independent' }, viewKey);
  expect(path).toEqual([primary, independent]);
  expect(expandedSideRange(path, 'independent', 1, viewKey)).toEqual({ start: 1, end: 1 });
});
