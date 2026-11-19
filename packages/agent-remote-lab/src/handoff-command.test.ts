// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handoffCommand, handoffProvider } from './handoff-command.js';

describe('the provider a /handoff command names', () => {
  it('is none for a bare command, with or without spaces', () => {
    expect(handoffProvider('')).toBeUndefined();
    expect(handoffProvider('   ')).toBeUndefined();
  });
  it('is the provider id, trimmed and in lower case', () => {
    expect(handoffProvider('claude')).toBe('claude');
    expect(handoffProvider('  Claude-Code ')).toBe('claude-code');
    expect(handoffProvider('opencode2')).toBe('opencode2');
  });
  it.each(['claude extra', 'claude;codex', '1claude', '-claude', 'claude_code', 'claude/codex', '/claude', 'cl@ude'])('refuses %j and says how to write the command', args => {
    expect(() => handoffProvider(args)).toThrow('Use /handoff or /handoff <provider>, for example /handoff claude.');
  });
  it('is registered as the console command handoff', () => {
    expect(handoffCommand).toMatchObject({ id: 'console:handoff', name: 'handoff', kind: 'command' });
  });
});
