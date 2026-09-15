import { describe, expect, it } from 'vitest';
import type { AgentHostProviderRegistration } from './host.js';
import { createHostRegistrations, selectedHostProviders } from './registrations.js';

describe('Host provider selection', () => {
  it('defaults to Codex and accepts explicit ordered providers', () => {
    expect(selectedHostProviders({})).toEqual(['codex']);
    expect(selectedHostProviders({ AGENT_HOST_PROVIDERS: 'claude' })).toEqual(['claude']);
    expect(selectedHostProviders({ AGENT_HOST_PROVIDERS: 'copilot' })).toEqual(['copilot']);
    expect(selectedHostProviders({ AGENT_HOST_PROVIDERS: ' codex, claude ' })).toEqual(['codex', 'claude']);
  });

  it.each(['', ' ', ',claude', 'claude,', 'codex,,claude', 'codex,codex', 'dsh'])('rejects invalid selection %j before creating providers', async (selection) => {
    let started = false;
    const factory = async () => { started = true; throw new Error('should not start'); };
    await expect(createHostRegistrations({ AGENT_HOST_PROVIDERS: selection }, undefined, { codex: factory, claude: factory, copilot: factory })).rejects.toThrow(/provider/i);
    expect(started).toBe(false);
  });

  it('passes provider-specific executable and home settings without modifying process environment', async () => {
    const seen: unknown[] = [];
    const factory = async (options: unknown) => { seen.push(options); return registration(); };
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const env = { AGENT_HOST_PROVIDERS: 'codex,claude,copilot', AGENT_HOST_COPILOT: '/copilot', AGENT_HOST_COPILOT_HOME: '/copilot-home', AGENT_REMOTE_CODEX_EXECUTABLE: '/codex', AGENT_REMOTE_CODEX_HOME: '/codex-home',
      AGENT_HOST_CLAUDE: '/claude', AGENT_HOST_CLAUDE_HOME: '/claude-home', AGENT_REMOTE_WORKSPACE: '/work' };
    const registrations = await createHostRegistrations(env, undefined, { codex: factory, claude: factory, copilot: factory });
    expect(registrations).toHaveLength(3);
    expect(seen[0]).toMatchObject({ executable: '/codex', codexHome: '/codex-home', workspaces: [{ id: '/work', path: '/work', name: '/work' }] });
    expect(seen[1]).toMatchObject({ executable: '/claude', claudeHome: '/claude-home', workspaces: [{ id: '/work', path: '/work', name: '/work' }] });
    expect(seen[2]).toMatchObject({ executable: '/copilot', copilotHome: '/copilot-home' });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(previous);
  });

  it('closes completed registrations when a later executable fails validation', async () => {
    let closed = false;
    const first = registration(); first.directory.close = async () => { closed = true; };
    await expect(createHostRegistrations({ AGENT_HOST_PROVIDERS: 'copilot,claude' }, undefined, {
      copilot: async () => first, codex: async () => registration(), claude: async () => { throw new Error('Claude unavailable'); },
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

it('selects native restrictions by default, supports the explicit local opt-out, and strips connection credentials', async () => {
  const seen: any[] = []; const factory = async (options: unknown) => { seen.push(options); return registration(); };
  for (const trusted of [undefined, 'true', '1']) await createHostRegistrations({ AGENT_HOST_TRUSTED_FULL_CONTROL: trusted,
    AGENT_HOST_REMOTE_KEY: 'connection-secret', AGENT_HOST_MANAGEMENT_TOKEN: 'management-secret', OPENAI_API_KEY: 'native-auth' },
    undefined, { codex: factory, claude: factory, copilot: factory });
  expect(seen.map(options => options.restrictedNative)).toEqual([true, true, false]);
  for (const options of seen) {
    expect(options.env.AGENT_HOST_REMOTE_KEY).toBeUndefined(); expect(options.env.AGENT_HOST_MANAGEMENT_TOKEN).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBe('native-auth');
  }
});

it('passes the locally configured shared Codex connection to its provider', async () => {
  let seen: unknown;
  const factory = async (options: unknown) => { seen = options; return registration(); };
  await createHostRegistrations({ AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_SOCKET: '/tmp/codex.sock', AGENT_HOST_TRUSTED_FULL_CONTROL: '1' },
    undefined, { codex: factory, claude: factory, copilot: factory });
  expect(seen).toMatchObject({ connectionMode: 'shared', socketPath: '/tmp/codex.sock', restrictedNative: false });
});

it('rejects an invalid Codex connection mode before starting providers', async () => {
  const factory = async () => { throw new Error('unexpected startup'); };
  await expect(createHostRegistrations({ AGENT_HOST_CODEX_CONNECTION: 'typo' }, undefined,
    { codex: factory, claude: factory, copilot: factory })).rejects.toThrow('Codex connection mode');
});

it('trusts shared Codex permissions only for Codex, retaining restrictions for the other providers', async () => {
  const seen: any[] = []; const factory = async (options: unknown) => { seen.push(options); return registration(); };
  await createHostRegistrations({ AGENT_HOST_PROVIDERS: 'codex,claude,copilot', AGENT_HOST_CODEX_CONNECTION: 'shared', AGENT_HOST_CODEX_TRUST_SHARED: '1' },
    undefined, { codex: factory, claude: factory, copilot: factory });
  expect(seen.map(options => options.restrictedNative)).toEqual([false, true, true]);
});
