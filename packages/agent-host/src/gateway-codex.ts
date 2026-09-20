import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HostConnection } from './connection-config.js';

interface GatewayCredentials { apiKey: string; keyId: string; baseUrl: string; model: string }
interface ManagedCredentials extends GatewayCredentials { hostId: string; serverUrl: string; previousManagedConfig?: string }
export function managedCodexHome(stateDir: string, env: NodeJS.ProcessEnv): string {
  const home = join(resolve(stateDir), 'gateway-codex');
  if ([env.CODEX_HOME, env.AGENT_REMOTE_CODEX_HOME].some(value => value && resolve(value) !== home)) {
    throw new Error('Gateway bootstrap requires its dedicated Codex home under AGENT_HOST_STATE_DIR; remove native home overrides.');
  }
  if (env.AGENT_HOST_CODEX_CONNECTION && env.AGENT_HOST_CODEX_CONNECTION !== 'private') throw new Error('Gateway bootstrap requires private Codex sessions.');
  return home;
}
function safeOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Gateway bootstrap requires HTTPS or a loopback HTTP address.');
  }
  return url;
}
function credentials(value: unknown): GatewayCredentials {
  if (!value || typeof value !== 'object') throw new Error('Gateway bootstrap returned invalid credentials.');
  const item = value as Partial<GatewayCredentials>;
  if (typeof item.apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(item.apiKey)
    || typeof item.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(item.keyId)
    || typeof item.model !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(item.model)
    || typeof item.baseUrl !== 'string' || item.baseUrl.length > 2048) throw new Error('Gateway bootstrap returned invalid credentials.');
  safeOrigin(item.baseUrl);
  return { apiKey: item.apiKey, keyId: item.keyId, model: item.model, baseUrl: item.baseUrl };
}
async function privateRead(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed Codex settings must be regular private files.');
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function savedCredentials(home: string): Promise<ManagedCredentials | undefined> {
  const text = await privateRead(join(home, 'gateway-credentials.json'));
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as ManagedCredentials;
    credentials(value);
    if (typeof value.hostId !== 'string' || typeof value.serverUrl !== 'string') throw new Error();
    return value;
  } catch { throw new Error('Managed Codex credentials are invalid; restore the private Host state before restarting.'); }
}
function environment(home: string, value: GatewayCredentials): NodeJS.ProcessEnv {
  return { CODEX_HOME: home, AGENT_REMOTE_CODEX_HOME: home, AGENT_HOST_CODEX_CONNECTION: 'private',
    AGENT_HOST_BOOTSTRAP_CODEX: '1', LC_ALL: 'C', CODEX_GATEWAY_API_KEY: value.apiKey };
}
function managedConfig(value: GatewayCredentials): string {
  return `# Managed by Agent Remote Controller.\nmodel_provider = "agent_gateway"\nmodel = ${JSON.stringify(value.model)}\n\n[model_providers.agent_gateway]\nname = "Account Gateway"\nbase_url = ${JSON.stringify(value.baseUrl)}\nwire_api = "responses"\nenv_key = "CODEX_GATEWAY_API_KEY"\n`;
}
export async function loadGatewayCodexEnvironment(stateDir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.AGENT_HOST_BOOTSTRAP_CODEX !== '1') return env;
  const home = managedCodexHome(stateDir, env);
  const saved = await savedCredentials(home);
  if (!saved) throw new Error('Gateway Codex initialization is incomplete. Start the Controller to initialize this Host.');
  return { ...env, ...environment(home, saved) };
}
async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function configureGatewayCodex(stateDir: string, connection: HostConnection, hostId: string): Promise<NodeJS.ProcessEnv> {
  const home = managedCodexHome(stateDir, connection.environment);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed Codex home must be a private directory.');
  await chmod(home, 0o700);
  const saved = await savedCredentials(home);
  const config = await privateRead(join(home, 'config.toml'));
  if (config !== undefined && !saved) throw new Error('Refusing to overwrite unmanaged Codex configuration.');
  const prefix = saved && config !== undefined
    ? [managedConfig(saved), saved.previousManagedConfig].find(value => typeof value === 'string' && value.length > 0 && config.startsWith(value)) : undefined;
  if (saved && config !== undefined && !prefix) throw new Error('Managed Codex configuration was modified; preserve your changes before reinitializing.');
  // Native Codex appends project trust settings when a session opens. Preserve those sections.
  const nativeSettings = prefix && config !== undefined ? config.slice(prefix.length) : '';
  const server = safeOrigin(connection.serverUrl);
  if (saved && (saved.serverUrl !== server.origin || saved.hostId !== hostId)) throw new Error('Managed Codex credentials belong to another Host or Relay. Use a separate state directory.');
  let response: Response;
  try {
    response = await fetch(new URL('/v1/remote/host/bootstrap', server), { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${connection.remoteKey}`, 'content-type': 'application/json' }, body: '{}' });
  } catch { throw new Error('Could not reach the Relay for Codex initialization. Restart the Controller to retry with the saved device credential.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gateway Codex initialization failed (HTTP ${response.status}). Check Host access and Gateway availability, then restart the Controller.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gateway bootstrap returned an empty response.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 16_384) { await reader.cancel(); throw new Error('Gateway bootstrap response is too large.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Gateway bootstrap returned invalid JSON.'); }
  const issued = credentials(value);
  const toml = managedConfig(issued) + nativeSettings;
  // Remember the last accepted config during the two-file update so interruption is recoverable.
  const marker = { ...issued, hostId, serverUrl: server.origin };
  await atomicWrite(join(home, 'gateway-credentials.json'), JSON.stringify({ ...marker, ...(prefix ? { previousManagedConfig: prefix } : {}) }) + '\n');
  await atomicWrite(join(home, 'config.toml'), toml);
  await atomicWrite(join(home, 'gateway-credentials.json'), JSON.stringify(marker) + '\n');
  return environment(home, issued);
}
