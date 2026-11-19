/** One call made as the local user of a Devbox Relay: signs in, runs it with the cookie and the user's base path, and signs out. */
export async function actAsLocalUser<T>(origin: string, call: (request: (method: string, path: string, body?: unknown) => Promise<Response>) => Promise<T>): Promise<T> {
  const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
  const { basePath } = await status.json() as { basePath: string };
  const headers = { cookie: status.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin, 'content-type': 'application/json' };
  try { return await call((method, path, body) => fetch(origin + basePath + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })); }
  finally { await (await fetch(origin + '/auth/logout', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) })).body?.cancel(); }
}
