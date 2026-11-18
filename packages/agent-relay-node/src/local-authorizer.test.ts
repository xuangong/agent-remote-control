import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createLocalLabAuthorizer } from './local-authorizer.js';

describe('createLocalLabAuthorizer', () => {
  const authorizer = createLocalLabAuthorizer('http://127.0.0.1:5175');

  it('authenticates only loopback requests with the exact configured Origin', async () => {
    expect(await authorizer.authenticate(request('127.0.0.1', 'http://127.0.0.1:5175')))
      .toEqual({ subject: 'local-lab' });
    expect(await authorizer.authenticate(request('::1', 'http://127.0.0.1:5175')))
      .toEqual({ subject: 'local-lab' });
    expect(await authorizer.authenticate(request('127.0.0.1', undefined))).toBeUndefined();
    expect(await authorizer.authenticate(request('127.0.0.1', 'http://localhost:5175'))).toBeUndefined();
    expect(await authorizer.authenticate(request('192.0.2.10', 'http://127.0.0.1:5175'))).toBeUndefined();
  });

  it('authorizes session controls and image resources only for the local principal', async () => {
    const local = { subject: 'local-lab' };
    const base = { principal: local, agentId: 'agent-1', request: request('127.0.0.1', 'http://127.0.0.1:5175') };

    expect(await authorizer.authorize({ ...base, action: 'attach' })).toBe(true);
    expect(await authorizer.authorize({ ...base, action: 'read_resource' })).toBe(true);
    for (const action of ['image_upload', 'send_message', 'resolve_resource'] as const) {
      expect(await authorizer.authorize({ ...base, action })).toBe(true);
      expect(await authorizer.authorize({ ...base, principal: { subject: 'foreign' }, action })).toBe(false);
    }
    expect(await authorizer.authorize({ ...base, principal: { subject: '' }, action: 'attach' })).toBe(false);
    expect(await authorizer.authorize({ ...base, principal: { subject: 'someone-else' }, action: 'attach' })).toBe(false);
  });
});

function request(remoteAddress: string, origin: string | undefined): IncomingMessage {
  return {
    headers: origin === undefined ? {} : { origin },
    socket: { remoteAddress },
  } as IncomingMessage;
}
