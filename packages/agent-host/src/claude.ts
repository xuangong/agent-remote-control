import { sanitizeNativeEnvironment } from './execution-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClaudeSessionDirectory } from './claude-directory.js';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';

export interface ClaudeHostRegistrationOptions {
  executable?: string;
  restrictedNative?: boolean;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  workspaces?: readonly AgentHostWorkspace[];
  claudeHome?: string;
}
export async function createClaudeHostRegistration(options: ClaudeHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const executable = options.executable ?? 'claude';
  const env = { ...sanitizeNativeEnvironment(options.env ?? {}), ...(options.claudeHome ? { CLAUDE_CONFIG_DIR: options.claudeHome } : {}) };
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 5000, env });
  const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(stdout.trim());
  const supported = match && (Number(match[1]) > 2 || Number(match[1]) === 2 &&
    (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 247));
  if (!supported) throw new Error(`Claude executable must be version 2.1.247 or newer; got ${stdout.trim() || 'unknown'}.`);
  const { ClaudeAgentProvider } = await import('@borgee/agent-provider-claude');
  const provider = new ClaudeAgentProvider({ executable, env, restrictedNative: options.restrictedNative, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic });
  return { adapter: provider, directory: createClaudeSessionDirectory(provider, options.workspaces ?? []) };
}
