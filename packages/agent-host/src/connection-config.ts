import { atomicWriteFile } from '@orchardworks/agent-platform';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PairingPurpose } from '@orchardworks/agent-remote-protocol';

export interface HostConnection { serverUrl: string; remoteKey: string; environment: NodeJS.ProcessEnv; pairingPurpose?: PairingPurpose }
const restartSettings = [
  'AGENT_HOST_PROVIDERS', 'AGENT_HOST_CODEX', 'AGENT_HOST_CLAUDE', 'AGENT_HOST_CLAUDE_HOME',
  'CODEX_HOME', 'LC_ALL', 'AGENT_HOST_CODEX_NOFILE', 'AGENT_HOST_BOOTSTRAP_CODEX', 'AGENT_HOST_GATEWAY_SETUP',
  'AGENT_HOST_CODEX_CONNECTION', 'AGENT_HOST_CODEX_AUTO_START', 'AGENT_HOST_CODEX_SOCKET', 'AGENT_HOST_CODEX_TRUST_SHARED',
  'AGENT_HOST_ALLOWED_WORKSPACE_ROOTS', 'AGENT_HOST_TRUSTED_FULL_CONTROL',
  'AGENT_HOST_COPILOT', 'AGENT_HOST_COPILOT_HOME', 'AGENT_HOST_WORKSPACE', 'AGENT_HOST_NAME', 'AGENT_HOST_VSCODE', 'AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS',
  'COPILOT_AUTO_UPDATE',
  'AGENT_HOST_OPENCODE_CALLBACK_CONFIG', 'AGENT_HOST_OPENCODE', 'AGENT_HOST_OPENCODE_TRUST_SHARED', 'AGENT_HOST_OPENCODE_URL', 'AGENT_HOST_OPENCODE_USERNAME', 'AGENT_HOST_OPENCODE_PASSWORD',
  'AGENT_REMOTE_CODEX_EXECUTABLE', 'AGENT_REMOTE_CODEX_HOME', 'AGENT_REMOTE_WORKSPACE',
] as const;
export function retainedHostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(restartSettings.flatMap(name => typeof env[name] === 'string' ? [[name, env[name]]] : []));
}
async function readSaved(stateDir: string): Promise<HostConnection | undefined> {
  let text: string;
  try { text = await readFile(join(stateDir, 'connection.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Could not read private Agent Host connection settings.'); }
  try {
    const value = JSON.parse(text) as HostConnection;
    if (!value || typeof value.serverUrl !== 'string' || !value.serverUrl.trim() || typeof value.remoteKey !== 'string' || !value.remoteKey.trim() || !value.environment || typeof value.environment !== 'object') throw new Error();
    return { serverUrl: value.serverUrl, remoteKey: value.remoteKey, environment: retainedHostEnvironment(value.environment),
      ...(value.pairingPurpose === 'host-only' || value.pairingPurpose === 'gateway-setup' ? { pairingPurpose: value.pairingPurpose } : {}) };
  } catch { throw new Error('Private Agent Host connection settings are invalid. Set AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY together to pair again.'); }
}
/** Native commands can reuse saved settings without requiring Relay pairing. */
export async function resolveHostEnvironment(stateDir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const saved = await readSaved(stateDir);
  return mergeHostEnvironment(saved?.environment, env);
}

function mergeHostEnvironment(saved: NodeJS.ProcessEnv | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...saved, ...env };
  if (env.AGENT_REMOTE_WORKSPACE !== undefined && env.AGENT_HOST_WORKSPACE === undefined) delete merged.AGENT_HOST_WORKSPACE;
  if (env.AGENT_REMOTE_CODEX_EXECUTABLE !== undefined && env.AGENT_HOST_CODEX === undefined) delete merged.AGENT_HOST_CODEX;
  if (env.CODEX_HOME !== undefined && env.AGENT_REMOTE_CODEX_HOME === undefined) delete merged.AGENT_REMOTE_CODEX_HOME;
  return merged;
}

export async function resolveHostConnection(stateDir: string, env: NodeJS.ProcessEnv): Promise<HostConnection> {
  const hasServer = env.AGENT_HOST_SERVER !== undefined;
  const hasKey = env.AGENT_HOST_REMOTE_KEY !== undefined;
  if (hasServer !== hasKey) throw new Error('Set AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY together; saved credentials cannot be mixed with connection overrides.');
  let saved: HostConnection | undefined;
  try { saved = await readSaved(stateDir); } catch (error) { if (!hasServer) throw error; }
  const serverUrl = (hasServer ? env.AGENT_HOST_SERVER : saved?.serverUrl)?.trim();
  const remoteKey = (hasKey ? env.AGENT_HOST_REMOTE_KEY : saved?.remoteKey)?.trim();
  if (!serverUrl || !remoteKey) throw new Error('AGENT_HOST_SERVER and AGENT_HOST_REMOTE_KEY are required for the first pairing.');
  const environment = mergeHostEnvironment(saved?.environment, env);
  return { serverUrl, remoteKey, environment, ...(!hasServer && saved?.pairingPurpose ? { pairingPurpose: saved.pairingPurpose } : {}) };
}
export async function saveRegisteredConnection<T>(stateDir: string, connection: HostConnection, accepted: Promise<T>): Promise<T> {
  const registered = await accepted;
  await serializedWrite(stateDir, () => writeConnection(stateDir, connection));
  return registered;
}

export async function saveIssuedCredential(stateDir: string, connection: HostConnection, credential: string): Promise<void> {
  await serializedWrite(stateDir, async () => {
    await writeConnection(stateDir, { ...connection, remoteKey: credential });
    connection.remoteKey = credential;
  });
}
const pendingWrites = new Map<string, Promise<void>>();
function serializedWrite(stateDir: string, write: () => Promise<void>): Promise<void> {
  const pending = (pendingWrites.get(stateDir) ?? Promise.resolve()).catch(() => undefined).then(write);
  pendingWrites.set(stateDir, pending);
  void pending.finally(() => { if (pendingWrites.get(stateDir) === pending) pendingWrites.delete(stateDir); }).catch(() => undefined);
  return pending;
}
async function writeConnection(stateDir: string, connection: HostConnection): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await atomicWriteFile(join(stateDir, 'connection.json'), JSON.stringify({
    serverUrl: connection.serverUrl, remoteKey: connection.remoteKey,
    ...(connection.pairingPurpose ? { pairingPurpose: connection.pairingPurpose } : {}),
    environment: retainedHostEnvironment(connection.environment),
  }));
}
