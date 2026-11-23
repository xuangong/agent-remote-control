import type { AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import type { RemoteHostUplinkClient, RemoteHostUplinkClientOptions } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { createAgentHost } from './host.js';
import type { AgentHostDirectory } from './session-core/types.js';

/**
 * The Controller's link to the Relay, played by a fake client factory (the `uplinkClient` option): what the Controller does with each connection's
 * state, credentials and closing, without a socket or a Relay.
 */
function startHost(extra: Partial<Parameters<typeof createAgentHost>[0]> = {}) {
  const connections: Array<{ options: RemoteHostUplinkClientOptions; closed: boolean; client: RemoteHostUplinkClient }> = [];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'fake', displayName: 'Fake' },
    async createSession() { throw new Error('No sessions here.'); }, async resumeSession() { throw new Error('No sessions here.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: 'fake', workspaces: async () => [], create: async () => 'n', list: async () => [], open: async () => { throw new Error('No sessions here.'); }, close: () => undefined,
  };
  const saved: string[] = [];
  const host = createAgentHost({
    installationId: 'installation-1', name: 'Host', registrations: [{ adapter, directory }], shutdownTimeoutMs: 100,
    uplink: { url: 'ws://relay.test/one', remoteKey: 'key-1', onCredential: async credential => { saved.push(credential); } },
    ...extra,
    uplinkClient: options => {
      const connection = { options, closed: false, client: undefined as unknown as RemoteHostUplinkClient };
      connection.client = {
        ready: Promise.resolve({ hostId: `host-${connections.length + 1}` }), close: async () => { connection.closed = true; },
        teamRequest: async () => ({}), outboxRequest: async () => ({}), teamSuccession: false,
      };
      connections.push(connection);
      return connection.client;
    },
  });
  return { host, connections, saved };
}

describe('the Controller on its uplink', () => {
  it('registers one connection and follows its state', async () => {
    const { host, connections } = startHost();
    expect(connections).toHaveLength(1);
    expect(host.state).toBe('connecting');
    connections[0]!.options.onStateChange?.('registered');
    expect(host.state).toBe('registered');
    connections[0]!.options.onStateChange?.('disconnected');
    expect(host.state).toBe('disconnected');
    await host.close();
  });

  it('closes the connection it replaces, and lets only the new one change its state', async () => {
    const { host, connections } = startHost();
    const replaced = await host.replaceUplink({ url: 'ws://relay.test/two', remoteKey: 'key-2' });
    expect(replaced).toEqual({ hostId: 'host-2' });
    expect(connections).toHaveLength(2);
    expect(connections[0]!.closed).toBe(true);
    connections[0]!.options.onStateChange?.('registered');
    expect(host.state).toBe('connecting');
    connections[1]!.options.onStateChange?.('registered');
    expect(host.state).toBe('registered');
    await host.close();
  });

  it('numbers the diagnostics of each connection by its generation', async () => {
    const seen: number[] = [];
    const { host, connections } = startHost({ onDiagnostic: diagnostic => { seen.push(diagnostic.uplinkGeneration); } });
    connections[0]!.options.onDiagnostic?.({ event: 'registered' } as never);
    await host.replaceUplink({ url: 'ws://relay.test/two', remoteKey: 'key-2' });
    connections[1]!.options.onDiagnostic?.({ event: 'registered' } as never);
    expect(seen).toEqual([1, 2]);
    await host.close();
  });

  it('saves a credential of the current connection, and refuses one a replacement superseded', async () => {
    const { host, connections, saved } = startHost();
    await connections[0]!.options.onCredential?.('first');
    await host.replaceUplink({ url: 'ws://relay.test/two', remoteKey: 'key-2', onCredential: async credential => { saved.push(`two:${credential}`); } });
    await expect(connections[0]!.options.onCredential?.('stale')).rejects.toThrow('Host credential persistence was superseded.');
    await connections[1]!.options.onCredential?.('second');
    expect(saved).toEqual(['first', 'two:second']);
    await host.close();
  });

  it('ends every connection when it closes, ignores what they report afterwards, and refuses a replacement', async () => {
    const { host, connections } = startHost();
    await host.close();
    expect(host.state).toBe('closed');
    expect(connections.every(connection => connection.closed)).toBe(true);
    connections[0]!.options.onStateChange?.('registered');
    expect(host.state).toBe('closed');
    await expect(host.replaceUplink({ url: 'ws://relay.test/two', remoteKey: 'key-2' })).rejects.toThrow('Agent Host is closed.');
  });
});
