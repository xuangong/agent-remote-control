import { expect, it } from 'vitest';
import { CLAUDE_PERMISSION_MODES, claudePermissionModeOptions, isResumableClaudePermissionMode } from './permission-modes.js';

it('offers every table mode in presentation order and labels the bypass mode YOLO', () => {
  const options = claudePermissionModeOptions('default');
  expect(options.map(option => option.value)).toEqual(['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']);
  expect(options.map(option => option.value)).toEqual(CLAUDE_PERMISSION_MODES.map(mode => mode.value));
  expect(options).toContainEqual(expect.objectContaining({ value: 'bypassPermissions', label: 'YOLO' }));
});

it('keeps an unrecognized current mode selectable so a selection always matches one option', () => {
  expect(claudePermissionModeOptions('auto')).toContainEqual({ value: 'auto', label: 'auto' });
  expect(claudePermissionModeOptions('default').filter(option => option.value === 'default')).toHaveLength(1);
  expect(claudePermissionModeOptions('plan').filter(option => option.value === 'plan')).toHaveLength(1);
});

it('resumes every known mode except planning', () => {
  expect(isResumableClaudePermissionMode('default')).toBe(true);
  expect(isResumableClaudePermissionMode('acceptEdits')).toBe(true);
  expect(isResumableClaudePermissionMode('dontAsk')).toBe(true);
  expect(isResumableClaudePermissionMode('bypassPermissions')).toBe(true);
  expect(isResumableClaudePermissionMode('plan')).toBe(false);
  expect(isResumableClaudePermissionMode('auto')).toBe(false);
  expect(isResumableClaudePermissionMode(undefined)).toBe(false);
});
