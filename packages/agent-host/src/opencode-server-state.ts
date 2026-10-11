import { openCodeVersionIssue } from '@orchardworks/agent-provider-opencode';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export class OpenCodeServerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface OpenCodeServerConfig { url: string; username: string; password: string }
export interface OpenCodeServerPreference { enabled: boolean; revision: string }
export interface OpenCodeServerOwner {
  pid: number; nativePid?: number; managementPort: number; token: string; generation: string; url: string;
}
export function openCodeServerLocation(stateDir: string, env: NodeJS.ProcessEnv) {
  let url: URL;
  try { url = new URL(env.AGENT_HOST_OPENCODE_URL ?? 'http://127.0.0.1:4096'); }
  catch { throw new OpenCodeServerError('opencode_invalid_url', 'The OpenCode server URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new OpenCodeServerError('opencode_invalid_url', 'Configure an HTTP OpenCode URL without credentials, query or fragment.');
  const endpoint = url.toString().replace(/\/$/, '');
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/';
  const managed = local && (endpoint === 'http://127.0.0.1:4096' || env.AGENT_HOST_OPENCODE_AUTO_START === '1');
  return { url: endpoint, managed, directory: join(resolve(stateDir), 'opencode-server', createHash('sha256').update(endpoint).digest('hex').slice(0, 24)) };
}
async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new OpenCodeServerError('opencode_state_invalid', 'The private OpenCode server state could not be read. Inspect its local state directory.');
  }
}
export async function readOpenCodeServerConfig(directory: string): Promise<OpenCodeServerConfig | undefined> {
  const value = await json(join(directory, 'config.json')) as OpenCodeServerConfig | undefined;
  if (!value) return undefined;
  validateOpenCodeServerConfig(value);
  return value;
}
function validateOpenCodeServerConfig(value: OpenCodeServerConfig): void {
  if (typeof value.url !== 'string' || value.username !== 'opencode'
    || typeof value.password !== 'string' || !value.password || /[\r\n]/.test(value.username + value.password))
    throw new OpenCodeServerError('opencode_state_invalid', 'OpenCode requires the username opencode and a non-empty password without line breaks.');
}
export async function ensureOpenCodeServerConfig(directory: string, url: string, env: NodeJS.ProcessEnv): Promise<OpenCodeServerConfig> {
  let value = await readOpenCodeServerConfig(directory);
  if (!value) {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const candidate = { url, username: env.AGENT_HOST_OPENCODE_USERNAME ?? 'opencode', password: env.AGENT_HOST_OPENCODE_PASSWORD ?? randomBytes(32).toString('hex') };
    validateOpenCodeServerConfig(candidate);
    const temporary = join(directory, `.config-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(candidate), { mode: 0o600, flag: 'wx' });
    try {
      // Publish complete credentials once, including across simultaneous Controller starts.
      try { await link(temporary, join(directory, 'config.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await rm(temporary, { force: true }); }
    value = (await readOpenCodeServerConfig(directory))!;
  }
  applyOpenCodeServerConfig(value, url, env);
  return value;
}
export function applyOpenCodeServerConfig(value: OpenCodeServerConfig, url: string, env: NodeJS.ProcessEnv): void {
  if (value.url !== url || env.AGENT_HOST_OPENCODE_USERNAME !== undefined && env.AGENT_HOST_OPENCODE_USERNAME !== value.username
    || env.AGENT_HOST_OPENCODE_PASSWORD !== undefined && env.AGENT_HOST_OPENCODE_PASSWORD !== value.password)
    throw new OpenCodeServerError('opencode_credentials_changed', 'OpenCode credentials differ from the managed server. Keep the existing credentials while its sessions are running.');
  env.AGENT_HOST_OPENCODE_USERNAME = value.username;
  env.AGENT_HOST_OPENCODE_PASSWORD = value.password;
}
export async function readOpenCodeServerPreference(directory: string): Promise<OpenCodeServerPreference> {
  const value = await json(join(directory, 'prefs.json')) as OpenCodeServerPreference | undefined;
  if (!value) return { enabled: true, revision: 'initial' };
  if (typeof value.enabled !== 'boolean' || typeof value.revision !== 'string' || !value.revision)
    throw new OpenCodeServerError('opencode_state_invalid', 'The OpenCode server auto-start preference is invalid.');
  return value;
}
export async function writeOpenCodeServerPreference(directory: string, enabled: boolean): Promise<OpenCodeServerPreference> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = { enabled, revision: randomUUID() };
  await atomicWriteFile(join(directory, 'prefs.json'), JSON.stringify(value)); return value;
}
export async function readOpenCodeServerOwner(path: string): Promise<OpenCodeServerOwner | undefined> {
  const v = await json(path) as OpenCodeServerOwner | undefined;
  if (!v) return undefined;
  if (!Number.isSafeInteger(v.pid) || v.pid <= 0 || !Number.isInteger(v.managementPort) || v.managementPort < 1 || v.managementPort > 65535
    || typeof v.token !== 'string' || !/^[a-f0-9]{64}$/.test(v.token) || typeof v.generation !== 'string' || !v.generation || typeof v.url !== 'string')
    throw new OpenCodeServerError('opencode_state_invalid', 'The private OpenCode server owner record is invalid.');
  return v;
}
export async function openCodeServerOwners(directory: string): Promise<OpenCodeServerOwner[]> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter(name => name === 'owner.json' || /^starting-[a-f\d-]+\.json$/.test(name))
    .map(name => readOpenCodeServerOwner(join(directory, name))));
  return [...new Map(records.filter((v): v is OpenCodeServerOwner => !!v).map(v => [v.generation, v])).values()];
}
export async function requestOpenCodeServerOwner(owner: OpenCodeServerOwner, action: 'status' | 'stop'): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${owner.managementPort}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, token: owner.token }), redirect: 'error', signal: AbortSignal.timeout(action === 'stop' ? 8000 : 1500) });
    if (!response.ok) return undefined;
    const value = await response.json() as Record<string, unknown>;
    if (value.error) throw new OpenCodeServerError('opencode_stop_failed', 'The managed OpenCode server could not confirm shutdown.');
    if (action === 'status' && (value.generation !== owner.generation || value.pid !== owner.pid || value.url !== owner.url)) return undefined;
    return value;
  } catch (error) {
    if (error instanceof OpenCodeServerError) throw error;
    return undefined;
  }
}

export async function probeOpenCodeServer(url: string, env: NodeJS.ProcessEnv): Promise<{ running: true; version: string; nativePid: number } | { running: false }> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/info`, { headers: env.AGENT_HOST_OPENCODE_PASSWORD === undefined ? {} : {
      authorization: `Basic ${Buffer.from(`${env.AGENT_HOST_OPENCODE_USERNAME ?? 'opencode'}:${env.AGENT_HOST_OPENCODE_PASSWORD}`).toString('base64')}`,
    }, redirect: 'error', signal: AbortSignal.timeout(1500) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
    if (cause?.code === 'ECONNREFUSED' || cause?.errors?.length && cause.errors.every(item => item.code === 'ECONNREFUSED')) return { running: false };
    throw new OpenCodeServerError('opencode_health_unreachable', 'OpenCode health could not be confirmed. The existing service will not be restarted.');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new OpenCodeServerError('opencode_auth_required', 'OpenCode rejected authentication. Configure matching server credentials in the Controller.');
  }
  let info: { version?: unknown; pid?: unknown; urls?: unknown; paths?: { tmp?: unknown } } | null;
  try {
    const reader = response.body?.getReader(); let contents = '';
    if (!reader) throw new Error();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; contents += Buffer.from(value).toString('utf8'); if (contents.length > 4096) throw new Error(); } }
    finally { await reader.cancel(); }
    info = JSON.parse(contents);
  } catch { throw new OpenCodeServerError('opencode_health_invalid', 'The configured port did not return valid OpenCode server information.'); }
  if (!response.ok || !info || typeof info.version !== 'string' || !Number.isSafeInteger(info.pid) || (info.pid as number) < 0
    || !Array.isArray(info.urls) || !info.urls.every(url => typeof url === 'string') || typeof info.paths?.tmp !== 'string')
    throw new OpenCodeServerError('opencode_health_invalid', 'The existing service did not provide valid OpenCode server identity. It will not be restarted automatically.');
  const issue = openCodeVersionIssue(info.version);
  if (issue) throw new OpenCodeServerError(issue.code, issue.message);
  return { running: true, version: info.version, nativePid: info.pid as number };
}
