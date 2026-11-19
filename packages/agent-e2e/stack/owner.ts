type Request = (method: string, path: string, body?: unknown) => Promise<Response>;

/** The local user of a Devbox Relay signed in once: `request` runs a call with the cookie and the user's base path, `close` signs out. */
export async function signInLocalUser(origin: string): Promise<{ request: Request; close(): Promise<void> }> {
  const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
  const { basePath } = await status.json() as { basePath: string };
  const headers = { cookie: status.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin, 'content-type': 'application/json' };
  return {
    request: (method, path, body) => fetch(origin + basePath + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) }),
    async close() { await (await fetch(origin + '/auth/logout', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) })).body?.cancel(); },
  };
}

/** One call made as the local user of a Devbox Relay: signs in, runs it, and signs out. */
export async function actAsLocalUser<T>(origin: string, call: (request: Request) => Promise<T>): Promise<T> {
  const user = await signInLocalUser(origin);
  try { return await call(user.request); } finally { await user.close(); }
}
