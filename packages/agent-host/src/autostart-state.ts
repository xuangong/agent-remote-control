import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveHostConnection, retainedHostEnvironment, type HostConnection } from './connection-config.js';

export async function autostartEnabled(stateDir: string): Promise<boolean> {
  try {
    const saved = JSON.parse(await readFile(join(stateDir, 'autostart.json'), 'utf8')) as { enabled?: unknown };
    if (typeof saved.enabled !== 'boolean') throw new Error();
    return saved.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new Error('Agent Host autostart preferences are invalid.');
  }
}

export async function atomicPrivate(path: string, contents: string): Promise<void> {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.autostart-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Windows readers and scanners can briefly hold the destination open.
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  finally { await rm(temporary, { force: true }); }
}

interface PendingConnection { id: string; previous?: string; connection: HostConnection }
async function connectionRevision(stateDir: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(join(stateDir, 'connection.json'))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function prepareAutostartConnection(stateDir: string, connection: HostConnection): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700);
  const pending: PendingConnection = { id: randomUUID(), previous: await connectionRevision(stateDir),
    connection: { serverUrl: connection.serverUrl, remoteKey: connection.remoteKey, environment: retainedHostEnvironment(connection.environment) } };
  await atomicPrivate(join(stateDir, 'autostart-start.json'), JSON.stringify(pending));
}

export async function resolveAutostartConnection(stateDir: string, environment: NodeJS.ProcessEnv): Promise<{ connection: HostConnection; pendingId?: string }> {
  let pending: PendingConnection | undefined;
  try { pending = JSON.parse(await readFile(join(stateDir, 'autostart-start.json'), 'utf8').catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(join(stateDir, 'launchd-start.json'), 'utf8');
  })) as PendingConnection; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Private Agent Host launch settings are invalid.'); }
  if (pending && pending.previous === await connectionRevision(stateDir)) {
    if (!pending.id || !pending.connection?.serverUrl || !pending.connection.remoteKey || !pending.connection.environment)
      throw new Error('Private Agent Host launch settings are invalid.');
    return { pendingId: pending.id, connection: await resolveHostConnection(stateDir, { ...environment,
      ...retainedHostEnvironment(pending.connection.environment), AGENT_HOST_SERVER: pending.connection.serverUrl, AGENT_HOST_REMOTE_KEY: pending.connection.remoteKey }) };
  }
  return { connection: await resolveHostConnection(stateDir, environment) };
}

export async function clearAutostartConnection(stateDir: string, pendingId: string | undefined): Promise<void> {
  if (!pendingId) return;
  for (const name of ['autostart-start.json', 'launchd-start.json']) {
    const path = join(stateDir, name);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as PendingConnection;
      if (saved.id === pendingId) await rm(path, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
