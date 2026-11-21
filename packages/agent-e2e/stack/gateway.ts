/**
 * A Gateway Relay that signs a person in through an issuer, as the hosted product does, for the flows that cover signing in. The issuer is
 * a small HTTP server that signs a ticket for the owner `alice`: its page offers a "Sign in as alice" link, or with `automaticSignIn` it
 * redirects to the Relay's callback at once, as a browser that is already signed in to the issuer is.
 */
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createGatewayRelay } from '@orchardworks/agent-relay-node/gateway-relay';
import { createGatewayStaticPages } from '@orchardworks/agent-relay-node/gateway-static';

export const GATEWAY_OWNER = 'alice';

export interface GatewayOptions {
  origin: string;
  webDist: string;
  automaticSignIn?: boolean;
  controllerReleases?: Parameters<typeof createGatewayRelay>[0]['controllerReleases'];
}

type Request = (method: string, path: string, body?: unknown) => Promise<Response>;

export async function createSignInGateway(options: GatewayOptions) {
  const secret = randomBytes(32).toString('base64url');
  const origin = options.origin;
  let automatic = options.automaticSignIn ?? false;
  const sign = (nonce: string, issuer: string) => {
    const iat = Math.floor(Date.now() / 1000);
    const content = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: issuer, aud: origin, sub: GATEWAY_OWNER, nonce, iat, exp: iat + 900, jti: randomUUID() }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
  };
  let issuer = '';
  const authority = createServer((request, response) => {
    const challenge = new URL(request.url!, issuer).searchParams.get('challenge')!;
    const callback = `${origin}/auth/callback#ticket=${sign(challenge, issuer)}`;
    if (automatic) { response.writeHead(302, { location: callback }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<a href="${callback}">Sign in as ${GATEWAY_OWNER}</a>`);
  });
  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(authority.address() as { port: number }).port}`;

  const createRelay = async () => {
    // The issuer signs tickets only, which a Relay without durable state accepts as the session; so this Relay keeps no state and no journals.
    const relay = createGatewayRelay({ origin, issuer, secret,
      ...(options.controllerReleases ? { controllerReleases: options.controllerReleases } : {}),
      servePage: await createGatewayStaticPages(options.webDist) });
    return { listen: (port: number, bind = '127.0.0.1') => relay.listen(port, bind), close: () => relay.close() };
  };

  /** The owner signed in once, as a browser is after the issuer's page: `request` runs a call with the cookie and the owner's base path. */
  async function signInOwner(): Promise<{ request: Request; close(): Promise<void> }> {
    const begin = await fetch(origin + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const challenge = new URL(begin.headers.get('location')!).searchParams.get('challenge')!;
    const accepted = await fetch(origin + '/auth/session', { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { origin, cookie: begin.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: sign(challenge, issuer) }) });
    if (!accepted.ok) throw new Error(`The owner could not sign in (${accepted.status}).`);
    const { basePath } = await accepted.json() as { basePath: string };
    const headers = { cookie: accepted.headers.get('set-cookie')!.split(';')[0]!, origin, 'content-type': 'application/json' };
    return {
      request: (method, path, body) => fetch(origin + basePath + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) }),
      async close() { await (await fetch(origin + '/auth/logout', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) })).body?.cancel(); },
    };
  }

  /** The key a Controller pairs with, made as the signed-in owner. */
  async function invitation(): Promise<{ serverUrl: string; remoteKey: string }> {
    const owner = await signInOwner();
    try {
      const response = await owner.request('POST', 'v1/remote/pairings', { purpose: 'host-only' });
      if (!response.ok) throw new Error(`The Controller invitation failed (${response.status}): ${await response.text()}`);
      const { key } = await response.json() as { key?: string };
      if (!key?.startsWith('arc_')) throw new Error('The Controller invitation was invalid.');
      return { serverUrl: origin, remoteKey: key };
    } finally { await owner.close(); }
  }

  return {
    createRelay, signInOwner, invitation,
    /** Whether the issuer signs a returning browser in without showing its page. */
    get automaticSignIn() { return automatic; },
    set automaticSignIn(value: boolean) { automatic = value; },
    async close() { authority.closeAllConnections(); await new Promise<void>(resolve => authority.close(() => resolve())); },
  };
}
