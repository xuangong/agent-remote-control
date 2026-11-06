import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { createGatewayRelay } from '../src/server/gateway-relay.js';
import { createGatewayStaticPages } from '../src/server/gateway-static.js';
import { createRecordedLabProvider } from '../src/server/recorded.js';
import { createSessionStatePublisher, liveSessionState } from '../../agent-host/src/session-state-publisher.js';
import type { SessionActivityState } from '@orchardworks/agent-remote-protocol';

export async function sessionLinkFixture(options: { automaticSignIn?: boolean; listCreatedSessions?: boolean; sessionStates?: boolean } = {}) {
  const secret = 'session-link-fixture-secret-01234567890123456789';
  let subject = 'alice';
  let url = '';
  const authority = createServer((request, response) => {
    const challenge = new URL(request.url!, issuer).searchParams.get('challenge');
    const ticket = sign(challenge!, subject);
    if (options.automaticSignIn) { response.writeHead(302, { location: `${url}/auth/callback#ticket=${ticket}` }); response.end(); return; }
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
  // Session references as a Controller keeps them: a Side's source, removable and restorable, and added sessions.
  const references = new Map<string, { revision: number; source?: { nativeSessionId: string; removed: boolean }; added: string[] }>();
  const describeReferences = (nativeSessionId: string) => {
    const saved = references.get(nativeSessionId) ?? { revision: 0, added: [] };
    const ref = (id: string, origin: 'source' | 'added') => ({ providerId: 'recorded', nativeSessionId: id, title: 'New session', origin });
    return { revision: saved.revision, refs: [...(saved.source && !saved.source.removed ? [ref(saved.source.nativeSessionId, 'source')] : []), ...saved.added.map(id => ref(id, 'added'))] };
  };
  // Shared session states as a Controller reports them; a test may hold a session in a state its recording never reaches.
  const heldStates = new Map<string, SessionActivityState>();
  const sessionStates = options.sessionStates ? createSessionStatePublisher({
    live: () => [...natives].flatMap(([nativeSessionId, agentId]) => {
      const state = heldStates.get(nativeSessionId) ?? liveSessionState(relay.requireAgent(agentId).handoffAdmissionState());
      return state ? [{ providerId: 'recorded', nativeSessionId, state }] : [];
    }),
    catalogs: () => [],
  }, { liveIntervalMs: 200 }) : undefined;
  const uplink = createRemoteHostUplinkClient({ relay, url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
    ...(sessionStates ? { sessionStates } : {}),
    installationId: randomUUID(), name: 'Cross-device Host', providers: [{ providerId: 'recorded', displayName: 'Recorded Provider', sessionReferences: true }],
    resolveSession: (id) => [...natives.values()].includes(id) ? relay.requireAgent(id) : undefined,
    async control(control) {
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: options.listCreatedSessions ? [...natives.keys()].map(nativeSessionId => ({ nativeSessionId, providerId: 'recorded', title: 'New session', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', state: 'idle' })) : [], hasMore: false, revision: String(natives.size) }) };
      if (control.path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [] }) };
      if (control.path.startsWith('/remote/session/refs?')) return { status: 200, body: JSON.stringify(describeReferences(new URL(control.path, 'http://host').searchParams.get('nativeSessionId')!)) };
      const body = JSON.parse(control.body ?? '{}');
      if (control.path === '/remote/session/refs') {
        const saved = references.get(body.nativeSessionId) ?? { revision: 0, added: [] }, target = body.target.nativeSessionId as string;
        if (saved.source?.nativeSessionId === target) saved.source.removed = body.action === 'remove';
        else saved.added = body.action === 'add' ? [...saved.added.filter(id => id !== target), target] : saved.added.filter(id => id !== target);
        references.set(body.nativeSessionId, { ...saved, revision: saved.revision + 1 });
        return { status: 200, body: JSON.stringify(describeReferences(body.nativeSessionId)) };
      }
      if (control.path === '/remote/attach' || control.path === '/remote/child/attach') {
        const agentId = natives.get(body.nativeSessionId);
        // A Controller reports a session its native agent does not have this way.
        return { status: agentId ? 200 : 404, body: JSON.stringify(agentId ? { agentId, nativeSessionId: body.nativeSessionId }
          : { error: 'The native session is unavailable on this Host.', code: 'native_session_unavailable' }) };
      }
      if (control.path !== '/remote/create') return { status: 404, body: '{}' };
      const nativeSessionId = randomUUID(); const agentId = randomUUID();
      await relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: {
        requestId: randomUUID(), operationId: body.operationId, agentId, providerId: 'recorded', config: { sessionId: nativeSessionId },
      } });
      natives.set(nativeSessionId, agentId);
      if (body.sourceNativeSessionId) references.set(nativeSessionId, { revision: 0, source: { nativeSessionId: body.sourceNativeSessionId, removed: false }, added: [] });
      return { status: 200, body: JSON.stringify({ agentId, nativeSessionId }) };
    },
  });
  const { hostId } = await uplink.ready;
  return { url, hostId, setSubject(value: string) { subject = value; },
    holdSessionState(nativeSessionId: string, state?: SessionActivityState) { if (state) heldStates.set(nativeSessionId, state); else heldStates.delete(nativeSessionId); },
    nativeSessionIds: () => [...natives.keys()],
    /** The native agent loses the session, as Codex did with a thread it never saved. */
    forgetSession(nativeSessionId: string) { natives.delete(nativeSessionId); },
    disconnectHost: () => uplink.close(),
    async close() {
    await uplink.close(); await relay.close(); await gateway.close();
    authority.closeAllConnections(); await new Promise<void>((resolve) => authority.close(() => resolve()));
  } };
}
