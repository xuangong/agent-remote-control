import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSessionSettingOption } from '@orchardworks/agent-provider-sdk';

/** A permission mode this adapter knows, how it is offered, and whether a session may resume into it. */
export interface ClaudePermissionMode {
  readonly value: PermissionMode;
  readonly label: string;
  readonly description?: string;
  /** Planning is transient state carried by the planning flag, so it is never a resume target. */
  readonly resumable: boolean;
}

export const CLAUDE_PERMISSION_MODES = [
  { value: 'default', label: 'Ask for permissions', resumable: true },
  { value: 'acceptEdits', label: 'Accept edits', resumable: true },
  { value: 'dontAsk', label: 'Deny unapproved tools', resumable: true },
  { value: 'plan', label: 'Plan', resumable: false },
  { value: 'bypassPermissions', label: 'YOLO',
    description: 'Runs every tool without asking and without a sandbox, with full access to this computer.', resumable: true },
] as const satisfies readonly ClaudePermissionMode[];

/** The sandbox a restricted Host requires for native commands. */
export const CLAUDE_RESTRICTED_SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } as const;

/**
 * The sandbox a permission mode runs under, as a native flag setting. YOLO runs without one, above the user's and
 * the project's own settings; an organization's managed policy still applies. Other modes keep a restricted Host's
 * sandbox, or else whatever the user's settings choose (null clears the flag).
 */
export function claudeSandbox(mode: PermissionMode, restricted: boolean): NonNullable<Options['sandbox']> | null {
  if (mode === 'bypassPermissions') return { enabled: false };
  return restricted ? CLAUDE_RESTRICTED_SANDBOX : null;
}

/**
 * A read-only session: no edit or planning tools, and commands run in a required sandbox that denies writes to the
 * workspace. Nothing asks; reads and scratch writes outside the workspace work. Verified with Claude Code 2.1.247;
 * planning alone is not enough, because it relies on approvals rather than the sandbox.
 */
export function claudeReadOnlyOptions(cwd: string) {
  return { permissionMode: 'dontAsk' as const, allowDangerouslySkipPermissions: false,
    disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode'],
    sandbox: { ...CLAUDE_RESTRICTED_SANDBOX, autoAllowBashIfSandboxed: true, filesystem: { denyWrite: [cwd] } } } satisfies Options;
}

/** The native runtime requires this acknowledgement before it accepts the bypass mode. */
export const CLAUDE_ALLOWS_BYPASS_PERMISSIONS = CLAUDE_PERMISSION_MODES.some(mode => mode.value === 'bypassPermissions');

/** The permission modes a session may persist and resume into. */
export type ResumableClaudePermissionMode = Extract<(typeof CLAUDE_PERMISSION_MODES)[number], { resumable: true }>['value'];

/** Selectable permission modes. A current mode outside the table stays selectable so the selection always matches. */
export function claudePermissionModeOptions(current: PermissionMode): AgentSessionSettingOption[] {
  const options = CLAUDE_PERMISSION_MODES.map((mode: ClaudePermissionMode) => ({ value: mode.value, label: mode.label,
    ...(mode.description ? { description: mode.description } : {}) }));
  return options.some(option => option.value === current) ? options : [...options, { value: current, label: current }];
}

export function isResumableClaudePermissionMode(value: unknown): value is ResumableClaudePermissionMode {
  return CLAUDE_PERMISSION_MODES.some(mode => mode.resumable && mode.value === value);
}
