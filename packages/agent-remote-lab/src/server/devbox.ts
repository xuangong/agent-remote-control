import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDevboxAuthentication } from './devbox-auth.js';
import { createGatewayRelay } from './gateway-relay.js';
import { createGatewayStaticPages } from './gateway-static.js';

export interface DevboxServerOptions {
  origin: string;
  stateDir: string;
  webDist: string;
}
export interface DevboxConnection { serverUrl: string; remoteKey: string }

/** Compose the complete hosted product with one local Devbox identity. */
export async function createDevboxServer(options: DevboxServerOptions) {
  const url = new URL(options.origin);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.port === '0' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Devbox requires a loopback HTTP origin with an explicit fixed port.');
  }
  const identity = await loadIdentity(options.stateDir, url.origin);
  const auth = { origin: url.origin, issuer: url.origin, secret: identity.secret, cookiePrefix: 'devbox' };
  const relay = createGatewayRelay({ ...auth, stateFile: join(options.stateDir, 'relay', 'state.json'),
    requestInterceptor: createDevboxAuthentication(auth),
    recentAuthentication: grant => grant.subject === 'devbox' ? true : undefined,
    // Return idle Window polls before an outer preview tunnel's response deadline.
    windowChangesWaitMs: 10000,
    originAliases: ['localhost', 'localhost.', '127.0.0.1', '[::1]'].map(host => `http://${host}:${url.port}`),
    servePage: await createGatewayStaticPages(options.webDist, { origin: url.origin, devbox: true }),
  });
  let started = false;
  let connection: Promise<DevboxConnection> | undefined;
  return {
    async listen(port: number, bind = '127.0.0.1') {
      if (port !== Number(url.port)) throw new Error('Devbox listen port must match its public origin.');
      const address = await relay.listen(port, bind); started = true; return address;
    },
    async close() { started = false; await relay.close(); },
    getConnection(): Promise<DevboxConnection> {
      if (!started) return Promise.reject(new Error('Start the Devbox server before pairing its Controller.'));
      if (!connection) {
        connection = pairController(auth.origin);
        void connection.catch(() => { connection = undefined; });
      }
      return connection;
    },
  };
}

async function loadIdentity(directory: string, origin: string): Promise<{ origin: string; secret: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'identity.json');
  try {
    const output = await open(file, 'wx', 0o600);
    try { await output.writeFile(JSON.stringify({ version: 1, origin, secret: randomBytes(32).toString('base64url') }) + '\n'); await output.sync(); }
    finally { await output.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const identity = JSON.parse(await readFile(file, 'utf8'));
  if (identity?.version !== 1 || typeof identity.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(identity.secret)) throw new Error('Devbox identity is invalid. Restore its state volume.');
  if (identity.origin !== origin) throw new Error('Devbox state belongs to another origin. Keep the saved port or select another state volume.');
  return identity;
}

async function pairController(origin: string): Promise<DevboxConnection> {
  const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
  if (!status.ok) throw new Error(`Devbox local identity is unavailable (${status.status}).`);
  const state = await status.json() as { basePath?: string };
  if (!state.basePath?.startsWith('/u/')) throw new Error('Devbox did not provide a local user namespace.');
  const cookie = status.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { cookie, origin, 'content-type': 'application/json' };
  try {
    const response = await fetch(origin + state.basePath + 'v1/remote/pairings', {
      method: 'POST', headers, body: JSON.stringify({ purpose: 'host-only' }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Devbox Controller pairing failed (${response.status}).`);
    const invitation = await response.json() as { key?: string; serverUrl?: string };
    if (!invitation.key?.startsWith('arc_') || invitation.serverUrl !== origin) throw new Error('Devbox Controller invitation was invalid.');
    return { serverUrl: origin, remoteKey: invitation.key };
  } finally {
    const logout = await fetch(origin + '/auth/logout', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) });
    await logout.body?.cancel();
  }
}
