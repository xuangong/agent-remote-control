import { describe, expect, it } from 'vitest';
import { relayLinkView, type RelayLinkFacts } from './relay-link.js';

const online: RelayLinkFacts = { accessReady: true, needsSignIn: false, channel: 'up', browserOnline: true };

describe('the device link to the Relay', () => {
  it.each<[string, Partial<RelayLinkFacts>, ReturnType<typeof relayLinkView>['state']]>([
    ['access ready, channel up', {}, 'online'],
    ['no channel yet: no claim', { channel: 'unknown' }, 'online'],
    ['channel lost', { channel: 'down' }, 'offline'],
    ['browser offline', { browserOnline: false }, 'offline'],
    ['access not ready', { accessReady: false }, 'offline'],
    ['sign-in needed', { needsSignIn: true }, 'sign_in'],
    ['sign-in needed wins over offline', { needsSignIn: true, channel: 'down', browserOnline: false, accessReady: false }, 'sign_in'],
  ])('%s', (_name, facts, state) => {
    expect(relayLinkView({ ...online, ...facts })).toEqual({ state });
  });
});
