import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@agent-remote-controller/agent-remote-relay';
import { createGatewayRelay } from '../src/server/gateway-relay.js';
import { createGatewayStaticPages } from '../src/server/gateway-static.js';
import { createRecordedLabProvider } from '../src/server/recorded.js';

export async function sessionLinkFixture() {
  const secret = 'session-link-fixture-secret-01234567890123456789';
  let subject = 'alice';
  let url = '';
  const authority = createServer((request, response) => {
    const challenge = new URL(request.url!, issuer).searchParams.get('challenge');
    const ticket = sign(challenge!, subject);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<a href="${url}/auth/callback#ticket=${ticket}">Sign in as ${subject}</a>`);
  });
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve));
  const address = authority.address();
  if (!address || typeof address === 'string') throw new Error('Missing issuer address');
  const issuer = `http://127.0.0.1:${address.port}`;
  const gateway = createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer, secret,
    servePage: await createGatewayStaticPages(resolve('dist')) });
  url = (await gateway.listen(0)).url;
  function sign(nonce: string, sub: string) {
    const iat = Math.floor(Date.now() / 1000);
    const content = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: issuer, aud: url, sub, nonce, iat, exp: iat + 900, jti: randomUUID() }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
  }
  const begin = await fetch(url + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const challenge = new URL(begin.headers.get('location')!).searchParams.get('challenge')!;
  const accepted = await fetch(url + '/auth/session', { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { origin: url, cookie: begin.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: sign(challenge, 'alice') }) });
  if (!accepted.ok) throw new Error('Fixture login failed');
  const cookie = accepted.headers.get('set-cookie')!.split(';')[0]!;
  const state = await accepted.json();
  const pairing = await fetch(url + state.basePath + 'v1/remote/pairings', { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { cookie, origin: url, 'content-type': 'application/json' }, body: '{}' });
  const invitation = await pairing.json();
  const relay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const natives = new Map<string, string>();
  const uplink = createRemoteHostUplinkClient({ relay, url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
    installationId: randomUUID(), name: 'Cross-device Host', providers: [{ providerId: 'recorded', displayName: 'Recorded Provider' }],
    resolveSession: (id) => [...natives.values()].includes(id) ? relay.requireAgent(id) : undefined,
    async control(control) {
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [], hasMore: false, revision: '1' }) };
      if (control.path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [] }) };
      const body = JSON.parse(control.body ?? '{}');
      if (control.path === '/remote/attach' || control.path === '/remote/child/attach') {
        const agentId = natives.get(body.nativeSessionId);
        return { status: agentId ? 200 : 404, body: JSON.stringify(agentId ? { agentId, nativeSessionId: body.nativeSessionId } : { error: 'Session unavailable' }) };
      }
      if (control.path !== '/remote/create') return { status: 404, body: '{}' };
      const nativeSessionId = randomUUID(); const agentId = randomUUID();
      await relay.createAgent({ protocolVersion: '1.4.0', type: 'create_agent', payload: {
        requestId: randomUUID(), operationId: body.operationId, agentId, providerId: 'recorded', config: { sessionId: nativeSessionId },
      } });
      natives.set(nativeSessionId, agentId);
      return { status: 200, body: JSON.stringify({ agentId, nativeSessionId }) };
    },
  });
  const { hostId } = await uplink.ready;
  return { url, hostId, setSubject(value: string) { subject = value; }, async close() {
    await uplink.close(); await relay.close(); await gateway.close();
    authority.closeAllConnections(); await new Promise<void>((resolve) => authority.close(() => resolve()));
  } };
}
