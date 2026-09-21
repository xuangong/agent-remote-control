import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HostConnection } from './connection-config.js';
import { configureGatewayCodex, managedCodexHome } from './gateway-codex.js';
import { atomicWrite, requestGatewayCredentials, safeOrigin, savedCredentials, type GatewayCredentials } from './gateway-credentials.js';
import { selectedHostProviders } from './registrations.js';

function managedClaudeHome(stateDir: string, env: NodeJS.ProcessEnv): string {
  const home = join(resolve(stateDir), 'gateway-claude');
  if ([env.AGENT_HOST_CLAUDE_HOME, env.CLAUDE_CONFIG_DIR].some(value => value && resolve(value) !== home)) {
    throw new Error('Gateway setup requires its dedicated Claude home under AGENT_HOST_STATE_DIR; remove native home overrides.');
  }
  return home;
}
async function configureGatewayClaude(stateDir: string, connection: HostConnection, hostId: string, issued: GatewayCredentials): Promise<NodeJS.ProcessEnv> {
  const home = managedClaudeHome(stateDir, connection.environment);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed Claude home must be a private directory.');
  await chmod(home, 0o700);
  const saved = await savedCredentials(home);
  const server = safeOrigin(connection.serverUrl);
  if (saved && (saved.hostId !== hostId || saved.serverUrl !== server.origin)) throw new Error('Managed Claude credentials belong to another Host or Relay. Use a separate state directory.');
  const base = safeOrigin(issued.baseUrl);
  base.pathname = base.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  await atomicWrite(join(home, 'gateway-credentials.json'), JSON.stringify({ ...issued, hostId, serverUrl: server.origin }) + '\n');
  return { AGENT_HOST_CLAUDE_HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: base.toString().replace(/\/$/, ''),
    ANTHROPIC_API_KEY: issued.apiKey, ANTHROPIC_MODEL: issued.model, ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined };
}

/** The Relay purpose authorizes setup; local provider selection chooses native adapters. */
export async function configureGatewayProviders(stateDir: string, connection: HostConnection, hostId: string,
  onCredential?: (secret: string) => void): Promise<NodeJS.ProcessEnv> {
  const providers = selectedHostProviders(connection.environment);
  if (providers.includes('copilot')) throw new Error('Gateway setup for copilot is not supported. Select codex or claude, or enroll a separate host-only Host with your existing Copilot login.');
  if (providers.includes('codex')) managedCodexHome(stateDir, connection.environment);
  if (providers.includes('claude')) managedClaudeHome(stateDir, connection.environment);
  const issued = await requestGatewayCredentials(connection);
  onCredential?.(issued.apiKey);
  const environment: NodeJS.ProcessEnv = { AGENT_HOST_GATEWAY_SETUP: '1' };
  for (const provider of providers) Object.assign(environment, provider === 'codex'
    ? await configureGatewayCodex(stateDir, connection, hostId, issued)
    : await configureGatewayClaude(stateDir, connection, hostId, issued));
  return environment;
}
