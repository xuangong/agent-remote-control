import { describe, expect, it } from 'vitest';
import type { AgentHostProviderRegistration } from './host.js';
import { createHostRegistrations, selectedHostProviders } from './registrations.js';

describe('Host provider selection', () => {
  it('defaults to Codex and accepts explicit ordered providers', () => {
    expect(selectedHostProviders({})).toEqual(['codex']);
    expect(selectedHostProviders({ AGENT_HOST_PROVIDERS: 'claude' })).toEqual(['claude']);
    expect(selectedHostProviders({ AGENT_HOST_PROVIDERS: ' codex, claude ' })).toEqual(['codex', 'claude']);
  });

  it.each(['', ' ', ',claude', 'claude,', 'codex,,claude', 'codex,codex', 'dsh'])('rejects invalid selection %j before creating providers', async (selection) => {
    let started = false;
    const factory = async () => { started = true; throw new Error('should not start'); };
    await expect(createHostRegistrations({ AGENT_HOST_PROVIDERS: selection }, undefined, { codex: factory, claude: factory })).rejects.toThrow(/provider/i);
    expect(started).toBe(false);
  });

  it('passes provider-specific executable and home settings without modifying process environment', async () => {
    const seen: unknown[] = [];
    const factory = async (options: unknown) => { seen.push(options); return registration(); };
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const env = { AGENT_HOST_PROVIDERS: 'codex,claude', AGENT_REMOTE_CODEX_EXECUTABLE: '/codex', AGENT_REMOTE_CODEX_HOME: '/codex-home',
      AGENT_HOST_CLAUDE: '/claude', AGENT_HOST_CLAUDE_HOME: '/claude-home', AGENT_REMOTE_WORKSPACE: '/work' };
    const registrations = await createHostRegistrations(env, undefined, { codex: factory, claude: factory });
    expect(registrations).toHaveLength(2);
    expect(seen[0]).toMatchObject({ executable: '/codex', codexHome: '/codex-home', workspaces: [{ id: '/work', path: '/work', name: '/work' }] });
    expect(seen[1]).toMatchObject({ executable: '/claude', claudeHome: '/claude-home', workspaces: [{ id: '/work', path: '/work', name: '/work' }] });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(previous);
  });

  it('closes completed registrations when a later executable fails validation', async () => {
    let closed = false;
    const first = registration(); first.directory.close = async () => { closed = true; };
    await expect(createHostRegistrations({ AGENT_HOST_PROVIDERS: 'codex,claude' }, undefined, {
      codex: async () => first, claude: async () => { throw new Error('Claude unavailable'); },
    })).rejects.toThrow('Claude unavailable');
    expect(closed).toBe(true);
  });
});

function registration(): AgentHostProviderRegistration {
  return { adapter: { descriptor: { providerId: 'codex', displayName: 'Codex' },
    async createSession() { throw new Error('unused'); }, async resumeSession() { throw new Error('unused'); } },
  directory: { providerId: 'codex', list: () => [], workspaces: () => [], async create() { throw new Error('unused'); },
    async open() { throw new Error('unused'); }, async close() {} } };
}
