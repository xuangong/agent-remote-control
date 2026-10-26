import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {mkdir, realpath} from 'node:fs/promises';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeInvocation, resolveNativeExecutable } from './platform/executables/index.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import type { AgentHostProviderRegistration, AgentHostWorkspace } from './host.js';
import {SessionReferenceStore} from './session-reference.js';
import {SessionPermissionModeStore} from './permission-mode-store.js';

export interface ClaudeHostRegistrationOptions {
  executable?: string;
  restrictedNative?: boolean;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  workspaces?: readonly AgentHostWorkspace[];
  claudeHome?: string;
  referenceDirectory?: string;
  /** Where each session's last confirmed permission mode is kept; defaults to the Controller state for this profile. */
  permissionModeDirectory?: string;
}
export async function createClaudeHostRegistration(options: ClaudeHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const env: NodeJS.ProcessEnv = { ...sanitizeNativeEnvironment(options.env ?? {}), ...(options.claudeHome ? { CLAUDE_CONFIG_DIR: options.claudeHome } : {}) };
  const executable = resolveNativeExecutable(options.executable ?? 'claude', '@anthropic-ai/claude-code/cli.js', env);
  const { stdout } = await promisify(execFile)(...nativeInvocation(executable, ['--version']), { timeout: 5000, windowsHide: true, env });
  const match = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(stdout.trim());
  const supported = match && (Number(match[1]) > 2 || Number(match[1]) === 2 &&
    (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 247));
  if (!supported) throw new Error(`Claude executable must be version 2.1.247 or newer; got ${stdout.trim() || 'unknown'}.`);
  const { ClaudeAgentProvider, isResumableClaudePermissionMode } = await import('@orchardworks/agent-provider-claude');
  const profile = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.claude');
  await mkdir(profile, {recursive: true});
  const canonicalProfile = await realpath(profile);
  const scope = createHash('sha256').update(canonicalProfile).digest('hex');
  const permissionModes = new SessionPermissionModeStore(options.permissionModeDirectory ?? join(homedir(), '.agent-remote-control', 'session-permissions', 'claude', scope), isResumableClaudePermissionMode);
  const provider = new ClaudeAgentProvider({ executable, env, restrictedNative: options.restrictedNative, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic, permissionModes });
  const ownership = {root: join(canonicalProfile, '.arc-session-owners'), onDiagnostic: (event: unknown) => options.onDiagnostic?.(JSON.stringify(event))};
  const references = new SessionReferenceStore(options.referenceDirectory ?? join(homedir(), '.agent-remote-control', 'session-references', 'claude', scope), 'claude');
  return { nativePermissionControl: true, nativeVersion: `${match[1]}.${match[2]}.${match[3]}`, adapter: provider, directory: createClaudeSessionDirectory(provider, options.workspaces ?? [], ownership, references) };
}
