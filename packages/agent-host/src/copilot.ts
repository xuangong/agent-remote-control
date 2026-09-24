import {join} from 'node:path';
import {homedir} from 'node:os';
import {mkdir, realpath} from 'node:fs/promises';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CopilotAgentProvider } from '@orchardworks/agent-provider-copilot';
import { copilotExecutable } from './copilot-executable.js';
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
  const env: NodeJS.ProcessEnv = { ...sanitizeNativeEnvironment(options.env ?? {}), ...(options.copilotHome ? { COPILOT_HOME: options.copilotHome } : {}) };
  const executable = await copilotExecutable(options.executable, env);
  const nodeEntry = /\.(?:m?js|cjs)$/i.test(executable);
  const { stdout } = await promisify(execFile)(nodeEntry ? process.execPath : executable,
    [...(nodeEntry ? [executable] : []), '--version'], { timeout: 30000, env });
  const match = /^GitHub Copilot CLI (\d+)\.(\d+)\.(\d+)\.?(?:\s|$)/.exec(stdout.trim());
  const supported = match && (Number(match[1]) > 1 || Number(match[1]) === 1 &&
    (Number(match[2]) > 0 || Number(match[2]) === 0 && Number(match[3]) >= 83));
  if (!supported) throw new Error(`Copilot executable must be GitHub Copilot CLI version 1.0.83 or newer; got ${stdout.trim() || 'unknown'}.`);
  const profile = env.COPILOT_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.copilot');
  await mkdir(profile, {recursive: true});
  const ownership = {root: join(await realpath(profile), '.arc-session-owners'), onDiagnostic: (event: unknown) => options.onDiagnostic?.(JSON.stringify(event))};
  const provider = new CopilotAgentProvider({ executable, env, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic });
  try {
    return { adapter: provider, directory: createCopilotSessionDirectory(provider, options.workspaces ?? [], ownership) };
  } catch (error) { await provider.dispose(); throw error; }
}
