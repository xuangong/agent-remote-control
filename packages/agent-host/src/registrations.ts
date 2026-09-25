import type { OpenCodeHostRegistrationOptions } from './opencode.js';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import type { CopilotHostRegistrationOptions } from './copilot.js';
import type { ClaudeHostRegistrationOptions } from './claude.js';
import type { CodexHostRegistrationOptions } from './codex.js';
import type { AgentHostProviderRegistration } from './host.js';

type HostProviderId = 'codex' | 'claude' | 'copilot' | 'opencode';
interface HostRegistrationFactories {
  opencode(options: OpenCodeHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
  copilot(options: CopilotHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
  codex(options: CodexHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
  claude(options: ClaudeHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
}
const defaultFactories: HostRegistrationFactories = {
  opencode: async options => (await import('./opencode.js')).createOpenCodeHostRegistration(options),
  copilot: async (options) => (await import('./copilot.js')).createCopilotHostRegistration(options),
  codex: async (options) => (await import('./codex.js')).createCodexHostRegistration(options),
  claude: async (options) => (await import('./claude.js')).createClaudeHostRegistration(options),
};

export function selectedHostProviders(env: NodeJS.ProcessEnv): HostProviderId[] {
  const selected = (env.AGENT_HOST_PROVIDERS ?? 'codex').split(',').map((value) => value.trim());
  const providers = new Set<HostProviderId>();
  for (const provider of selected) {
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'copilot' && provider !== 'opencode') throw new Error(`Unknown or empty Agent Host provider: ${provider || '(empty)'}. Use a comma-separated selection of codex, claude, copilot, opencode.`);
    if (providers.has(provider)) throw new Error(`Duplicate Agent Host provider: ${provider}.`);
    providers.add(provider);
  }
  return [...providers];
}

export async function createHostRegistrations(env: NodeJS.ProcessEnv, onDiagnostic?: (line: string) => void,
  factories: HostRegistrationFactories = defaultFactories): Promise<AgentHostProviderRegistration[]> {
  const providers = selectedHostProviders(env);
  const connectionMode = env.AGENT_HOST_CODEX_CONNECTION ?? 'shared';
  if (providers.includes('codex') && connectionMode !== 'private' && connectionMode !== 'shared') throw new Error('Codex connection mode must be private or shared.');
  const workspace = env.AGENT_HOST_WORKSPACE ?? env.AGENT_REMOTE_WORKSPACE ?? process.cwd();
  const common = { env: sanitizeNativeEnvironment(env), onDiagnostic, restrictedNative: env.AGENT_HOST_TRUSTED_FULL_CONTROL !== '1', workspaces: workspace ? [{ id: workspace, name: workspace, path: workspace }] : [] };
  const registrations: AgentHostProviderRegistration[] = [];
  try {
    for (const provider of providers) {
      const nativeEnv = { ...common.env };
      if (env.AGENT_HOST_GATEWAY_SETUP === '1') {
        if (provider !== 'codex') nativeEnv.CODEX_GATEWAY_API_KEY = undefined;
        if (provider !== 'claude') nativeEnv.ANTHROPIC_API_KEY = undefined;
      }
      registrations.push(provider === 'codex'
        ? await factories.codex({ ...common, env: nativeEnv, executable: env.AGENT_HOST_CODEX ?? env.AGENT_REMOTE_CODEX_EXECUTABLE, codexHome: env.AGENT_REMOTE_CODEX_HOME,
          connectionMode: connectionMode as 'private' | 'shared', socketPath: env.AGENT_HOST_CODEX_SOCKET,
          restrictedNative: connectionMode === 'shared' && (env.AGENT_HOST_CODEX_TRUST_SHARED ?? '1') === '1' ? false : common.restrictedNative })
        : provider === 'opencode'
        ? await factories.opencode({ workspaces: common.workspaces, restrictedNative: (env.AGENT_HOST_OPENCODE_TRUST_SHARED ?? '1') === '1' ? false : common.restrictedNative, onDiagnostic,
          serverUrl: env.AGENT_HOST_OPENCODE_URL, username: env.AGENT_HOST_OPENCODE_USERNAME, password: env.AGENT_HOST_OPENCODE_PASSWORD })
        : provider === 'copilot'
        ? await factories.copilot({ ...common, env: nativeEnv, executable: env.AGENT_HOST_COPILOT, copilotHome: env.AGENT_HOST_COPILOT_HOME })
        : await factories.claude({ ...common, env: nativeEnv, executable: env.AGENT_HOST_CLAUDE, claudeHome: env.AGENT_HOST_CLAUDE_HOME }));
    }
    return registrations;
  } catch (error) {
    await Promise.allSettled(registrations.map(({ directory }) => Promise.resolve().then(() => directory.close())));
    throw error;
  }
}
