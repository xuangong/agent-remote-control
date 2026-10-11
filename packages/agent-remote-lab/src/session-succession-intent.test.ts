import { afterEach, expect, it } from 'vitest';
import { clearSuccessionIntent, loadSuccessionIntent, saveSuccessionIntent } from './session-succession-intent.js';
afterEach(() => sessionStorage.clear());
it('retains the exact original recipient and operation across reload and separates workspace scopes', () => {
  const intent = { source: { hostId: 'host', agentId: 'agent', providerId: 'opencode', nativeSessionId: 'A', title: 'Original' }, operation: { operationId: 'original-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 6, targetProviderId: 'opencode' } };
  saveSuccessionIntent('owner-scope', intent);
  expect(loadSuccessionIntent('owner-scope')).toEqual(intent);
  expect(loadSuccessionIntent('other-owner')).toBeUndefined();
  clearSuccessionIntent('owner-scope'); expect(loadSuccessionIntent('owner-scope')).toBeUndefined();
}, 5000);

it('keeps sticky cancellation with the original operation across reload', () => {
  const intent = { source: { hostId: 'host', agentId: 'agent', providerId: 'opencode', nativeSessionId: 'A', title: 'Original' }, operation: { operationId: 'cancel-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 6, targetProviderId: 'opencode' }, cancelRequested: true };
  saveSuccessionIntent('scope', intent); expect(loadSuccessionIntent('scope')).toEqual(intent);
}, 5000);
