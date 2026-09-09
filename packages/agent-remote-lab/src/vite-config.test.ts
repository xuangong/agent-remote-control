// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const relayTargetEnvironment = 'VITE_AGENT_REMOTE_RELAY_TARGET';
const originalRelayTarget = process.env[relayTargetEnvironment];

afterEach(() => {
  if (originalRelayTarget === undefined) delete process.env[relayTargetEnvironment];
  else process.env[relayTargetEnvironment] = originalRelayTarget;
  vi.resetModules();
});

describe('Agent Remote Lab Vite configuration', () => {
  it('proxies the public protocol to the fixed local Relay port by default', async () => {
    delete process.env[relayTargetEnvironment];
    vi.resetModules();

    const { default: config } = await import('../vite.config.js');
    if (typeof config === 'function') throw new Error('Expected a static Vite configuration.');

    expect(config.server?.proxy?.['/v1']).toMatchObject({
      target: 'http://127.0.0.1:4910',
      ws: true,
    });
  });
});
