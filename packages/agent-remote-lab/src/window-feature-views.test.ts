import { expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createWindowFeature, featureView, openFeatureView, parseWindowFeature } from './window-feature-views.js';

function initial(): WorkspaceWindow {
  return { schemaVersion: 1, id: 'window', title: 'Window', revision: 0, primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false,
    views: [createWindowView('main', undefined, 'primary'), createWindowView('source')] };
}
it('keeps typed feature metadata stable and rejects unsupported business metadata', () => {
  const feature = { kind: 'team' as const, id: 'team', role: 'member' as const, memberId: 'stable-member' };
  expect(parseWindowFeature(createWindowFeature(feature))).toEqual(feature);
  expect(parseWindowFeature({ kind: 'other', id: 'team', metadata: { role: 'member' } })).toBeUndefined();
  expect(parseWindowFeature({ kind: 'team', id: 'team', metadata: { role: 'unknown' } })).toBeUndefined();
  expect(parseWindowFeature({ kind: 'tpm', id: 'work' })).toBeUndefined();
});
it('uses explicit managed bindings and lifecycle edges for feature views', () => {
  let window = initial();
  const authority = { get window() { return window; }, operate(operation: Parameters<typeof applyWindowOperation>[1]) { window = applyWindowOperation(window, operation); } };
  openFeatureView(authority, { kind: 'ask', id: 'question' }, undefined, 'source');
  openFeatureView(authority, { kind: 'tpm', id: 'work', hostId: 'host' }, undefined, 'source');
  expect(window.views).toHaveLength(4);
  expect(featureView(window, 'ask', 'question')).toMatchObject({ bindingPolicy: 'managed', closeWith: 'source' });
  expect(featureView(window, 'tpm', 'work')).toMatchObject({ bindingPolicy: 'managed', closeWith: 'source' });
  window = applyWindowOperation(window, { type: 'view.close', viewId: 'source' });
  expect(window.views.map(view => view.id)).toEqual(['main']);
});
it('does not dispatch unknown tags or malformed known associations as application features', () => {
  const window = initial();
  window.views[1]!.feature = { kind: 'external', id: 'same', metadata: { kind: 'ask', role: 'member' } };
  expect(featureView(window, 'ask', 'same')).toBeUndefined();
  window.views[1]!.feature = { kind: 'tpm', id: 'same', metadata: { hostId: '' } };
  expect(featureView(window, 'tpm', 'same')).toBeUndefined();
});
it('round trips explicit Ask source references and rejects partial anchors', () => {
  const feature = { kind: 'ask' as const, id: 'ask', source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'original', agentId: 'reference-agent', title: 'Original', roleKey: 'verified-locally' } };
  expect(parseWindowFeature(createWindowFeature(feature))).toEqual(feature);
  expect(parseWindowFeature({ kind: 'ask', id: 'bad', metadata: { sourceProviderId: 'codex' } })).toBeUndefined();
});
