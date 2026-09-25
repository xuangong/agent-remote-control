import { afterEach, expect, it, vi } from 'vitest';
import { loadAdapter } from './load-adapter.js';

const constructions = vi.hoisted(() => [] as unknown[]);
vi.mock('./providers/opencode.js', () => ({ OpenCodeAgentProvider: class {
  descriptor = { providerId: 'opencode', displayName: 'OpenCode' };
  constructor(options: unknown) { constructions.push(options); }
} }));
afterEach(() => { vi.unstubAllEnvs(); constructions.length = 0; });

it('loads OpenCode using local server configuration without launching an executable', async () => {
  vi.stubEnv('AGENT_HOST_OPENCODE_URL', 'http://127.0.0.1:45001');
  vi.stubEnv('AGENT_HOST_OPENCODE_USERNAME', 'local');
  vi.stubEnv('AGENT_HOST_OPENCODE_PASSWORD', 'local-secret');
  const adapter = await loadAdapter('opencode', undefined, undefined);
  expect(adapter.descriptor.providerId).toBe('opencode');
  expect(constructions).toEqual([{ serverUrl: 'http://127.0.0.1:45001', username: 'local', password: 'local-secret' }]);
});

it('rejects executable overrides for the externally managed OpenCode server', async () => {
  await expect(loadAdapter('opencode', undefined, '/tmp/native')).rejects.toThrow('OpenCode connects to an existing server');
});
