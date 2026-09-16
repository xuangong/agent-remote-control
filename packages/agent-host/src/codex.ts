import { sanitizeNativeEnvironment } from './execution-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexAppServerProvider, type CodexAppServerProviderOptions } from '@agent-remote-controller/agent-provider-codex';
import { createCodexSessionDirectory } from './directory.js';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';

export interface CodexHostRegistrationOptions extends CodexAppServerProviderOptions {
  workspaces?: readonly AgentHostWorkspace[];
  codexHome?: string;
}

export async function createCodexHostRegistration(options: CodexHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const executable = options.executable ?? 'codex';
  const env = { ...sanitizeNativeEnvironment(options.env ?? {}), ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) };
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 5000, env });
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 148) throw new Error(`Codex executable must be version 0.148.0 or newer; got ${stdout.trim() || 'unknown'}.`);
  const provider = new CodexAppServerProvider({ ...options, env });
  return { adapter: provider, directory: createCodexSessionDirectory(provider, options.workspaces ?? []) };
}
