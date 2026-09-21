import { expect, it, vi } from 'vitest';
import { createRemoteHostPluginHost, type RemoteHostSessionLease } from './remote-host-plugin.js';
import { createAgentRemoteRelay } from '../relay.js';

it('releases a session acquired after its stream was closed without opening a ghost stream', async () => {
  let resolve!: (lease: RemoteHostSessionLease | undefined) => void;
  const release = vi.fn();
  const sent: string[] = [];
  const relay = createAgentRemoteRelay({ providers: [] });
  const host = createRemoteHostPluginHost(relay, {
    resolveSession: () => undefined,
    acquireSession: () => new Promise(done => { resolve = done; }),
    control: () => ({ status: 200, body: '{}' }), send: json => sent.push(json), onFailure: error => { throw error; },
  });
  host.receive(JSON.stringify({ uplinkVersion: 2, type: 'stream_open', streamId: 's', sessionId: 'a' }));
  host.receive(JSON.stringify({ uplinkVersion: 2, type: 'stream_close', streamId: 's', code: 1000, reason: 'sleep' }));
  resolve({ agent: {} as RemoteHostSessionLease['agent'], release });
  await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
  expect(sent.map(json => JSON.parse(json).type)).not.toContain('stream_opened');
  host.close(); await relay.close();
});

it('does not let a late acquisition retire a replacement stream with the same identity', async () => {
  const resolves: Array<(lease: RemoteHostSessionLease) => void> = [];
  const firstRelease = vi.fn(), secondRelease = vi.fn();
  const sent: string[] = [];
  const relay = createAgentRemoteRelay({ providers: [] });
  const host = createRemoteHostPluginHost(relay, { resolveSession: () => undefined,
    acquireSession: () => new Promise(resolve => resolves.push(resolve)),
    control: () => ({ status: 200, body: '{}' }), send: json => sent.push(json), onFailure: error => { throw error; } });
  const receive = (type: string) => host.receive(JSON.stringify({ uplinkVersion: 2, type, streamId: 'reused',
    ...(type === 'stream_open' ? { sessionId: 'a' } : { code: 1000, reason: 'disconnect' }) }));
  receive('stream_open'); receive('stream_close'); receive('stream_open');
  resolves[1]!({ agent: {} as RemoteHostSessionLease['agent'], release: secondRelease });
  await Promise.resolve(); await Promise.resolve();
  resolves[0]!({ agent: {} as RemoteHostSessionLease['agent'], release: firstRelease });
  await Promise.resolve(); await Promise.resolve();
  expect(firstRelease).toHaveBeenCalledTimes(1);
  expect(secondRelease).not.toHaveBeenCalled();
  expect(sent.map(json => JSON.parse(json).type)).toEqual(['stream_opened']);
  host.close(); await Promise.resolve(); await Promise.resolve();
  expect(secondRelease).toHaveBeenCalledTimes(1);
  await relay.close();
});
