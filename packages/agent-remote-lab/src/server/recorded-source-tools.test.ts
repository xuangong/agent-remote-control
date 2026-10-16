// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createProtocolValidationServer } from '../server.js';
import { createRecordedLabProvider } from './recorded.js';

it('creates a source-bound recorded session over HTTP and executes its fixed source history tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recorded-source-tools-'));
  const { provider, controller } = createRecordedLabProvider();
  const origin = 'http://127.0.0.1:5175';
  const server = createProtocolValidationServer({
    providers: [provider], labOrigin: origin, successionStateDirectory: join(root, 'state'),
    imageDirectory: join(root, 'images'), resourceDirectory: join(root, 'resources'), teamResourceDirectory: join(root, 'team-resources'),
  });
  try {
    const { url } = await server.http.listen(0);
    const providers = await fetch(`${url}/v1/providers?protocolVersion=1.8.0`, { signal: AbortSignal.timeout(5000) });
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({
      type: 'provider_list', payload: { providers: [{ providerId: 'recorded', displayName: 'Recorded semantic Provider' }] },
    });
    const post = (path: string, body: unknown) => fetch(`${url}/v1/remote/${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const sourceResponse = await post('create', { providerId: 'recorded', operationId: 'source' });
    expect(sourceResponse.status).toBe(200);
    const source = await sourceResponse.json();
    await server.relay.requireAgent(source.agentId).sendMessage('Only the original source contains this detail.');
    const readerResponse = await post('create', { providerId: 'recorded', operationId: 'reader', sourceNativeSessionId: source.nativeSessionId });
    expect(readerResponse.status).toBe(200);
    const reader = await readerResponse.json();

    const result = JSON.parse(await controller.executeTool(reader.nativeSessionId, 'read_source_session', { query: 'original source', limit: 1 }));
    expect(result.sourceSessionId).toBe(source.nativeSessionId);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].text).toContain('Only the original source contains this detail.');
    await expect(controller.executeTool(source.nativeSessionId, 'read_source_session', {})).rejects.toThrow('is not available');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
