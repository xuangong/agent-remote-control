import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CopilotAgentProvider, resolveCopilotExecutable } from '@borgee/agent-provider-copilot';
import { createCopilotSessionDirectory } from './copilot-directory.js';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';

export interface CopilotHostRegistrationOptions {
  executable?: string;
  copilotHome?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  workspaces?: readonly AgentHostWorkspace[];
}

export async function createCopilotHostRegistration(options: CopilotHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const executable = options.executable ?? resolveCopilotExecutable();
  const env = { ...process.env, ...options.env, ...(options.copilotHome ? { COPILOT_HOME: options.copilotHome } : {}) };
  const nodeEntry = /\.(?:m?js|cjs)$/i.test(executable);
  const { stdout } = await promisify(execFile)(nodeEntry ? process.execPath : executable,
    [...(nodeEntry ? [executable] : []), '--version'], { timeout: 5000, env });
  const match = /^GitHub Copilot CLI (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(stdout.trim());
  const supported = match && (Number(match[1]) > 1 || Number(match[1]) === 1 &&
    (Number(match[2]) > 0 || Number(match[2]) === 0 && Number(match[3]) >= 83));
  if (!supported) throw new Error(`Copilot executable must be GitHub Copilot CLI version 1.0.83 or newer; got ${stdout.trim() || 'unknown'}.`);
  const provider = new CopilotAgentProvider({ executable, env, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic });
  try {
    return { adapter: provider, directory: createCopilotSessionDirectory(provider, options.workspaces ?? []) };
  } catch (error) { await provider.dispose(); throw error; }
}
