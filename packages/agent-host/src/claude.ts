import {join} from 'node:path';
import {homedir} from 'node:os';
import {mkdir, realpath} from 'node:fs/promises';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeInvocation, resolveNativeExecutable } from './platform/executables/index.js';
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
  const env: NodeJS.ProcessEnv = { ...sanitizeNativeEnvironment(options.env ?? {}), ...(options.claudeHome ? { CLAUDE_CONFIG_DIR: options.claudeHome } : {}) };
  const executable = resolveNativeExecutable(options.executable ?? 'claude', '@anthropic-ai/claude-code/cli.js', env);
  const { stdout } = await promisify(execFile)(...nativeInvocation(executable, ['--version']), { timeout: 5000, windowsHide: true, env });
  const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(stdout.trim());
  const supported = match && (Number(match[1]) > 2 || Number(match[1]) === 2 &&
    (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 247));
  if (!supported) throw new Error(`Claude executable must be version 2.1.247 or newer; got ${stdout.trim() || 'unknown'}.`);
  const { ClaudeAgentProvider } = await import('@orchardworks/agent-provider-claude');
  const provider = new ClaudeAgentProvider({ executable, env, restrictedNative: options.restrictedNative, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic });
  const profile = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.claude');
  await mkdir(profile, {recursive: true});
  const ownership = {root: join(await realpath(profile), '.arc-session-owners'), onDiagnostic: (event: unknown) => options.onDiagnostic?.(JSON.stringify(event))};
  return { adapter: provider, directory: createClaudeSessionDirectory(provider, options.workspaces ?? [], ownership) };
}
