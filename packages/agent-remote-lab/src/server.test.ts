import { afterEach, describe, expect, it } from 'vitest';

import { createProtocolValidationServer } from './server.js';

describe('createProtocolValidationServer', () => {
  const servers: ReturnType<typeof createProtocolValidationServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('requires providers and the exact browser Origin at the shared composition boundary', () => {
    const server = createProtocolValidationServer({
      providers: [],
      labOrigin: 'http://127.0.0.1:5175',
    });
    servers.push(server);
    expect(server.relay.listProviders()).toEqual([]);
  });

  it('rejects a session mutation from a different browser Origin', async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/v1/sessions`, {
      method: 'POST',
      headers: { origin: 'http://malicious.test', 'content-type': 'application/json' },
      body: createBody,
    });

    expect(response.status).toBe(403);
  });

  it('rejects a session mutation without an application/json content type', async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/v1/sessions`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5175', 'content-type': 'text/plain' },
      body: createBody,
    });

    expect(response.status).toBe(415);
  });

  it('allows a JSON session mutation from a non-browser local client without Origin', async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      type: 'protocol_error', payload: { code: 'provider_not_found' },
    });
  });

  async function startServer(): Promise<{ url: string }> {
    const server = createProtocolValidationServer({
      providers: [],
      labOrigin: 'http://127.0.0.1:5175',
    });
    servers.push(server);
    return server.http.listen(0, '127.0.0.1');
  }
});

const createBody = JSON.stringify({
  protocolVersion: '1.4.0',
  type: 'create_agent',
  payload: {
    requestId: 'create-1', agentId: 'agent-1', providerId: 'missing',
    config: { sessionId: 'session-1' },
  },
});
