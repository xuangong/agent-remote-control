// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { firstInputPending, forkCommandRoute, forkCreateOptions, forkedSession, forkKey, forkSettings, needsWorkspaceLookup, withForkContext, workspaceOptions } from './fork-plan.js';

describe('what a conversation command does', () => {
  it.each(['', '  ', 'on', 'OFF', ' Enable ', 'disable'])('treats /ask %j as a setting of the Ask', args => expect(forkCommandRoute('console:ask', args)).toBe('ask-setting'));
  it('opens the Ask for a question', () => expect(forkCommandRoute('console:ask', 'why is it slow')).toBe('ask-open'));
  it('creates a fork for any other command, whatever its arguments', () => {
    expect(forkCommandRoute('console:fork', '')).toBe('fork');
    expect(forkCommandRoute('console:side', 'on')).toBe('fork');
  });
  it('keys an attempt by source, command and arguments', () => {
    expect(forkKey('s', 'console:fork', 'a')).toBe(forkKey('s', 'console:fork', 'a'));
    for (const other of [forkKey('t', 'console:fork', 'a'), forkKey('s', 'console:side', 'a'), forkKey('s', 'console:fork', 'b')]) expect(other).not.toBe(forkKey('s', 'console:fork', 'a'));
  });
});

describe('the settings a fork carries', () => {
  const setting = (id: string, value: string | null, mutable = true, scope = 'session') => ({ id, value, mutable, scope });
  it('are the mutable session settings that are set', () => {
    expect(forkSettings([setting('a', 'x'), setting('b', null), setting('c', 'y', false), setting('d', 'z', true, 'session_and_default')])).toEqual([{ id: 'a', value: 'x' }]);
  });
});

describe('where a forked session starts', () => {
  const agent = { cwd: '/work', model: 'gpt', capabilities: { planning: true }, planningActive: true };
  it('stands where the source stands: directory, model and planning', () => {
    expect(forkCreateOptions(agent, 'codex')).toEqual({ cwd: '/work', model: 'gpt', planning: true });
  });
  it('carries the planning state the source had, only when the source supports planning', () => {
    expect(forkCreateOptions({ ...agent, planningActive: false }, 'codex')).toEqual({ cwd: '/work', model: 'gpt', planning: false });
    expect(forkCreateOptions({ ...agent, capabilities: {} }, 'codex')).toEqual({ cwd: '/work', model: 'gpt' });
  });
  it('leaves out what the source lacks', () => expect(forkCreateOptions({ ...agent, cwd: null, model: null, capabilities: {} }, 'codex')).toEqual({}));
  it('leaves out the model and planning for dsh', () => expect(forkCreateOptions(agent, 'dsh')).toEqual({ cwd: '/work' }));
  it('looks a workspace up for a remote dsh source only', () => {
    expect(needsWorkspaceLookup({ hostId: 'h1', providerId: 'dsh' })).toBe(true);
    expect(needsWorkspaceLookup({ hostId: 'local', providerId: 'dsh' })).toBe(false);
    expect(needsWorkspaceLookup({ providerId: 'dsh' })).toBe(false);
    expect(needsWorkspaceLookup({ hostId: 'h1', providerId: 'codex' })).toBe(false);
  });
  it('uses the registered workspace of the source directory', () => {
    expect(workspaceOptions('/work', [{ id: 'w0', path: '/other' }, { id: 'w1', path: '/work' }])).toEqual({ workspaceId: 'w1' });
  });
  it('starts without a workspace when the source has no directory, and refuses a directory that is no longer registered', () => {
    expect(workspaceOptions(undefined, [{ id: 'w1', path: '/work' }])).toEqual({});
    expect(() => workspaceOptions('/gone', [{ id: 'w1', path: '/work' }])).toThrow('The source workspace is no longer registered on this Host.');
  });
});

describe('the context of a fork', () => {
  const source = { providerId: 'codex', nativeSessionId: 'native' };
  it('copies the conversation from the source', () => {
    expect(withForkContext({ cwd: '/w' }, source)).toEqual({ cwd: '/w', creationSource: { providerId: 'codex', nativeSessionId: 'native' } });
    expect(withForkContext({}, source)).toEqual({ creationSource: { providerId: 'codex', nativeSessionId: 'native' } });
  });
});

describe('the forked session', () => {
  it('is titled after the source, keeps the capture time, and takes the native id of the Host', () => {
    expect(forkedSession({ providerId: 'codex', hostId: 'h1', title: 'Plan' }, { agentId: 'a', nativeSessionId: 'n' }, 't1'))
      .toEqual({ agentId: 'a', nativeSessionId: 'n', providerId: 'codex', hostId: 'h1', title: 'Fork of Plan', createdAt: 't1' });
  });
  it('falls back to the agent id and the local Host', () => {
    expect(forkedSession({ providerId: 'codex', title: 'Plan' }, { agentId: 'a' }, 't1')).toMatchObject({ nativeSessionId: 'a', hostId: 'local' });
  });
  it('sends the text after the command as the first input unless it was delivered', () => {
    expect(firstInputPending('hello', undefined)).toBe(true);
    expect(firstInputPending('hello', 'pending')).toBe(true);
    expect(firstInputPending('hello', 'sent')).toBe(false);
    expect(firstInputPending('  ', undefined)).toBe(false);
    expect(firstInputPending('', undefined)).toBe(false);
  });
});
