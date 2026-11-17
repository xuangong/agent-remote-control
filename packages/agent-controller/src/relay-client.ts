import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import { CliError } from './cli-output.js';

/**
 * A command line's own session at the Relay, approved by the signed-in user in a browser (agent-remote-controller login).
 * It acts as that user, like a browser session, and is listed and revocable beside them.
 */
export interface CliCredentials { serverUrl: string; basePath: string; cookieName: string; token: string; expiresAt: number }

export const credentialsPath = (stateDir: string) => join(stateDir, 'cli-credentials.json');

export async function readCredentials(stateDir: string): Promise<CliCredentials | undefined> {
  const path = credentialsPath(stateDir);
  let raw: string;
  try {
    if (process.platform !== 'win32' && (await stat(path)).mode & 0o077) throw new CliError('insecure_credentials', `${path} must be private. Run chmod 600 on it, or log in again.`);
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    return undefined;
  }
  const value = JSON.parse(raw) as Partial<CliCredentials>;
  if (typeof value.serverUrl !== 'string' || typeof value.basePath !== 'string' || !/^\/u\/[^/]+\/$/.test(value.basePath) || typeof value.cookieName !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(value.cookieName) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt)) return undefined;
  return value as CliCredentials;
}

export async function saveCredentials(stateDir: string, credentials: CliCredentials): Promise<void> {
  const path = credentialsPath(stateDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, JSON.stringify(credentials));
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

export async function forgetCredentials(stateDir: string): Promise<void> { await rm(credentialsPath(stateDir), { force: true }); }

/** The Relay's origin, checked like a browser checks it: HTTPS, or HTTP on this computer, without credentials. */
export function relayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('invalid_server', 'The Relay URL is invalid.'); }
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new CliError('invalid_server', 'Use an HTTPS Relay URL, or HTTP on this computer.');
  }
  return url.origin;
}

/** One request to the Relay as the signed-in user, as the website sends it: /auth/ paths at its origin, others in the user's namespace. */
export async function relayRequest(credentials: CliCredentials, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown,
  fetcher: typeof fetch = fetch, timeoutMs = 120_000): Promise<{ status: number; data: any }> {
  const origin = relayOrigin(credentials.serverUrl);
  let response: Response;
  try {
    response = await fetcher(path.startsWith('/auth/') ? `${origin}${path}` : `${origin}${credentials.basePath}${path.replace(/^\//, '')}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { cookie: `${credentials.cookieName}=${credentials.token}`, origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new CliError('relay_unreachable', 'The Relay could not be reached.');
  }
  const raw = await response.text();
  let data: any = {};
  if (raw) try { data = JSON.parse(raw); } catch { throw new CliError('invalid_response', 'The Relay returned an invalid answer.'); }
  if (response.status === 401) throw new CliError('signed_out', 'The command line session ended. Run agent-remote-controller login again.');
  return { status: response.status, data };
}

/** A Relay answer as a command error: its code when it has one. */
export function relayError(status: number, data: any): CliError {
  const code = typeof data?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(data.code) ? data.code : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status >= 500 ? 'relay_unavailable' : 'request_rejected';
  return new CliError(code, typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : 'The Relay refused the request.');
}
