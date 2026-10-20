import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
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
    description: 'Skip permission prompts. Existing sandbox restrictions still apply.', resumable: true },
] as const satisfies readonly ClaudePermissionMode[];

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
