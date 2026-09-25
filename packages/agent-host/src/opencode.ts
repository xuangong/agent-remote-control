import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionReferenceStore } from './session-reference.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import type { OpenCodeAgentProviderOptions } from '@orchardworks/agent-provider-opencode';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';

export interface OpenCodeHostRegistrationOptions extends OpenCodeAgentProviderOptions {
  workspaces?: readonly AgentHostWorkspace[];
  referenceDirectory?: string;
}

export async function createOpenCodeHostRegistration(options: OpenCodeHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const { OpenCodeAgentProvider } = await import('@orchardworks/agent-provider-opencode');
  const { workspaces = [], referenceDirectory, ...providerOptions } = options;
  const provider = new OpenCodeAgentProvider({ ...providerOptions, restrictedNative: options.restrictedNative ?? false });
  let callbacksAvailable = false;
  try { if (options.callbackConfigPath) callbacksAvailable = await provider.supportsHostCallbacks(workspaces[0]?.path ?? process.cwd()); }
  catch (error) { await provider.close(); throw error; }
  const scope = createHash('sha256').update(new URL(options.serverUrl ?? 'http://127.0.0.1:4096').toString()).digest('hex');
  const references = new SessionReferenceStore(referenceDirectory ?? join(homedir(), '.agent-remote-control', 'session-references', 'opencode', scope), 'opencode');
  return { adapter: provider, directory: createOpenCodeSessionDirectory(provider, workspaces, references, callbacksAvailable),
    preservesWorkOnDisconnect: true, nativePermissionControl: options.restrictedNative !== true };
}
