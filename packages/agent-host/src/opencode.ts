import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import type { OpenCodeAgentProviderOptions } from '@orchardworks/agent-provider-opencode';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';

export interface OpenCodeHostRegistrationOptions extends OpenCodeAgentProviderOptions {
  workspaces?: readonly AgentHostWorkspace[];
}

export async function createOpenCodeHostRegistration(options: OpenCodeHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const { OpenCodeAgentProvider } = await import('@orchardworks/agent-provider-opencode');
  const { workspaces = [], ...providerOptions } = options;
  const provider = new OpenCodeAgentProvider({ ...providerOptions, restrictedNative: options.restrictedNative ?? false });
  return { adapter: provider, directory: createOpenCodeSessionDirectory(provider, workspaces),
    preservesWorkOnDisconnect: true, nativePermissionControl: options.restrictedNative !== true };
}
