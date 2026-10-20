import { expect, it } from 'vitest';
import { remoteSessionState } from './session-state.js';

it('does not treat a refused session as recovering, so input is not held for a reconnect that will not happen', () => {
  expect(remoteSessionState(undefined, 'unavailable')).toMatchObject({ connection: 'unavailable', synchronized: false, recovering: false });
  expect(remoteSessionState(undefined, 'disconnected')).toMatchObject({ connection: 'disconnected', recovering: true });
});
