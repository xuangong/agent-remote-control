import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostConnection } from './connection-config.js';

export interface GatewayCredentials { apiKey: string; keyId: string; baseUrl: string; model: string }
export interface ManagedCredentials extends GatewayCredentials { hostId: string; serverUrl: string; previousManagedConfig?: string }
export function safeOrigin(value: string): URL {
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
export async function privateRead(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed Gateway settings must be regular private files.');
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function savedCredentials(home: string): Promise<ManagedCredentials | undefined> {
  const text = await privateRead(join(home, 'gateway-credentials.json'));
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as ManagedCredentials;
    credentials(value);
    if (typeof value.hostId !== 'string' || typeof value.serverUrl !== 'string') throw new Error();
    return value;
  } catch { throw new Error('Managed Gateway credentials are invalid; restore the private Host state before restarting.'); }
}
export async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function requestGatewayCredentials(connection: HostConnection): Promise<GatewayCredentials> {
  const server = safeOrigin(connection.serverUrl);
  let response: Response;
  try {
    response = await fetch(new URL('/v1/remote/host/bootstrap', server), { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${connection.remoteKey}`, 'content-type': 'application/json' }, body: '{}' });
  } catch { throw new Error('Could not reach the Relay for CLI initialization. Restart the Controller to retry with the saved device credential.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gateway CLI initialization failed (HTTP ${response.status}). Check Host access and Gateway availability, then restart the Controller.`);
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
  return credentials(value);
}
