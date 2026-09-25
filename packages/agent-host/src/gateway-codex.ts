import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HostConnection } from './connection-config.js';
import { selectedHostProviders } from './registrations.js';

import { atomicWrite, privateRead, requestGatewayCredentials, safeOrigin, savedCredentials, type GatewayCredentials } from './gateway-credentials.js';
export function managedCodexHome(stateDir: string, env: NodeJS.ProcessEnv): string {
  const home = join(resolve(stateDir), 'gateway-codex');
  if ([env.CODEX_HOME, env.AGENT_REMOTE_CODEX_HOME].some(value => value && resolve(value) !== home)) {
    throw new Error('Gateway bootstrap requires its dedicated Codex home under AGENT_HOST_STATE_DIR; remove native home overrides.');
  }
  if (env.AGENT_HOST_CODEX_CONNECTION && !['private', 'shared'].includes(env.AGENT_HOST_CODEX_CONNECTION)) throw new Error('Invalid Codex connection mode for Gateway bootstrap.');
  return home;
}
function environment(home: string, value: GatewayCredentials): NodeJS.ProcessEnv {
  return { CODEX_HOME: home, AGENT_REMOTE_CODEX_HOME: home, AGENT_HOST_CODEX_CONNECTION: 'shared',
    AGENT_HOST_BOOTSTRAP_CODEX: '1', LC_ALL: 'C', CODEX_GATEWAY_API_KEY: value.apiKey };
}
function managedConfig(value: GatewayCredentials): string {
  return `# Managed by Agent Remote Controller.\nmodel_provider = "agent_gateway"\nmodel = ${JSON.stringify(value.model)}\n\n[model_providers.agent_gateway]\nname = "Account Gateway"\nbase_url = ${JSON.stringify(value.baseUrl)}\nwire_api = "responses"\nenv_key = "CODEX_GATEWAY_API_KEY"\n`;
}
export async function loadGatewayCodexEnvironment(stateDir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.AGENT_HOST_BOOTSTRAP_CODEX !== '1'
    && !(env.AGENT_HOST_GATEWAY_SETUP === '1' && selectedHostProviders(env).includes('codex'))) return env;
  const home = managedCodexHome(stateDir, env);
  const saved = await savedCredentials(home);
  if (!saved) throw new Error('Gateway Codex initialization is incomplete. Start the Controller to initialize this Host.');
  return { ...env, ...environment(home, saved) };
}
export async function configureGatewayCodex(stateDir: string, connection: HostConnection, hostId: string, issuedCredentials?: GatewayCredentials): Promise<NodeJS.ProcessEnv> {
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
  const issued = issuedCredentials ?? await requestGatewayCredentials(connection);
  const toml = managedConfig(issued) + nativeSettings;
  // Remember the last accepted config during the two-file update so interruption is recoverable.
  const marker = { ...issued, hostId, serverUrl: server.origin };
  await atomicWrite(join(home, 'gateway-credentials.json'), JSON.stringify({ ...marker, ...(prefix ? { previousManagedConfig: prefix } : {}) }) + '\n');
  await atomicWrite(join(home, 'config.toml'), toml);
  await atomicWrite(join(home, 'gateway-credentials.json'), JSON.stringify(marker) + '\n');
  return environment(home, issued);
}
