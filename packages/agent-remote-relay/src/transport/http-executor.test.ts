import { afterEach, describe, expect, it } from 'vitest';
import * as remote from '../index.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0)) await close(); });

describe('transport-neutral HTTP execution', () => {
  it('returns the same encoded public result through the executor and Node HTTP adapter', async () => {
    const relay = remote.createAgentRemoteRelay({ providers: [] });
    closeables.push(() => relay.close());
    const server = remote.createAgentRemoteHttpServer(relay);
    const address = await server.listen(0, '127.0.0.1');
    closeables.push(() => server.close());
    expect(remote.executeAgentRemoteHttpRequest).toBeTypeOf('function');
    for (const path of ['/v1/providers?protocolVersion=1.2.0', '/v1/providers',
      '/v1/sessions/missing/snapshot?protocolVersion=1.2.0', '/v1/sessions/%ZZ/timeline?protocolVersion=1.2.0']) {
      const executed = await remote.executeAgentRemoteHttpRequest(relay, { method: 'GET', path });
      const response = await fetch(`${address.url}${path}`);
      expect(executed).toEqual({ status: response.status, body: await response.text() });
    }
  });

  it('rejects oversized public bodies and absolute request targets without a listener', async () => {
    const relay = remote.createAgentRemoteRelay({ providers: [] });
    closeables.push(() => relay.close());
    expect(remote.executeAgentRemoteHttpRequest).toBeTypeOf('function');
    const oversized = await remote.executeAgentRemoteHttpRequest(relay, {
      method: 'POST', path: '/v1/sessions', body: 'x'.repeat(1_048_577),
    });
    expect(oversized).toMatchObject({ status: 400 });
    expect(JSON.parse(oversized.body)).toMatchObject({ payload: { code: 'request_body_too_large' } });
    expect(await remote.executeAgentRemoteHttpRequest(relay, { method: 'GET', path: 'http://other/v1/providers' }))
      .toMatchObject({ status: 400 });
  });
});
