import type { CopilotHostRegistrationOptions } from './copilot.js';
import type { ClaudeHostRegistrationOptions } from './claude.js';
import type { CodexHostRegistrationOptions } from './codex.js';
import type { AgentHostProviderRegistration } from './host.js';

type HostProviderId = 'codex' | 'claude' | 'copilot';
interface HostRegistrationFactories {
  copilot(options: CopilotHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
  codex(options: CodexHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
  claude(options: ClaudeHostRegistrationOptions): Promise<AgentHostProviderRegistration>;
}
const defaultFactories: HostRegistrationFactories = {
  copilot: async (options) => (await import('./copilot.js')).createCopilotHostRegistration(options),
  codex: async (options) => (await import('./codex.js')).createCodexHostRegistration(options),
  claude: async (options) => (await import('./claude.js')).createClaudeHostRegistration(options),
};

export function selectedHostProviders(env: NodeJS.ProcessEnv): HostProviderId[] {
  const selected = (env.AGENT_HOST_PROVIDERS ?? 'codex').split(',').map((value) => value.trim());
  const providers = new Set<HostProviderId>();
  for (const provider of selected) {
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'copilot') throw new Error(`Unknown or empty Agent Host provider: ${provider || '(empty)'}. Use a comma-separated selection of codex, claude, copilot.`);
    if (providers.has(provider)) throw new Error(`Duplicate Agent Host provider: ${provider}.`);
    providers.add(provider);
  }
  return [...providers];
}

export async function createHostRegistrations(env: NodeJS.ProcessEnv, onDiagnostic?: (line: string) => void,
  factories: HostRegistrationFactories = defaultFactories): Promise<AgentHostProviderRegistration[]> {
  const providers = selectedHostProviders(env);
  const workspace = env.AGENT_HOST_WORKSPACE ?? env.AGENT_REMOTE_WORKSPACE;
  const common = { env, onDiagnostic, workspaces: workspace ? [{ id: workspace, name: workspace, path: workspace }] : [] };
  const registrations: AgentHostProviderRegistration[] = [];
  try {
    for (const provider of providers) {
      registrations.push(provider === 'codex'
        ? await factories.codex({ ...common, executable: env.AGENT_HOST_CODEX ?? env.AGENT_REMOTE_CODEX_EXECUTABLE, codexHome: env.AGENT_REMOTE_CODEX_HOME })
        : provider === 'copilot'
        ? await factories.copilot({ ...common, executable: env.AGENT_HOST_COPILOT, copilotHome: env.AGENT_HOST_COPILOT_HOME })
        : await factories.claude({ ...common, executable: env.AGENT_HOST_CLAUDE, claudeHome: env.AGENT_HOST_CLAUDE_HOME }));
    }
    return registrations;
  } catch (error) {
    await Promise.allSettled(registrations.map(({ directory }) => Promise.resolve().then(() => directory.close())));
    throw error;
  }
}
