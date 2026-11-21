import { describe, expect, it } from 'vitest';
import { nativeEnvironment, TerminalDriver, terminalCommand, terminalOutcome, triesAgain } from './terminal.js';

const places = { checkout: '/src/checkout', workspace: '/instances/one/workspace' };

describe('how a terminal turn ended', () => {
  it("reads the CLI's exit and its own words", () => {
    expect(terminalOutcome(0, '')).toBe('delivered');
    // Codex's turn order for the clients of its shared daemon, and its single writer for a separate process (codex 0.171).
    expect(terminalOutcome(1, 'Error: remote thread already has an active turn\n')).toBe('turn-busy');
    expect(terminalOutcome(1, 'Error: thread/resume: thread/resume failed: thread 01a1 already has an active writer (code -32600)\n')).toBe('writer-busy');
    expect(terminalOutcome(1, 'Error: not signed in')).toBe('failed');
    expect(terminalOutcome(null, 'spawn claude ENOENT')).toBe('failed');
  });
  it('tries again only while another client of the daemon holds the turn', () => {
    expect(['delivered', 'turn-busy', 'writer-busy', 'failed'].filter(outcome => triesAgain(outcome as never))).toEqual(['turn-busy']);
  });
});

describe('the terminal of a session', () => {
  it("joins a Codex session through the instance's shared daemon, from the checkout, and resumes a Claude session in the workspace", () => {
    expect(terminalCommand('codex', 'thread-1', 'Say A.', places)).toEqual({ file: 'agent-remote-controller-dev', args: ['codex', 'exec', 'resume', 'thread-1', 'Say A.'], cwd: '/src/checkout' });
    expect(terminalCommand('claude', 'session-1', 'Say B.', places)).toEqual({ file: 'claude', args: ['--resume', 'session-1', '-p', 'Say B.'], cwd: '/instances/one/workspace' });
    expect(() => terminalCommand('claude', '--last', 'x', places)).toThrow(/not a session id/);
    expect(() => terminalCommand('copilot', 'x', 'x', places)).toThrow(/No terminal turn/);
  });
  it("sees what the instance's sessions see: no agent, grant or package-manager state", () => {
    const environment = nativeEnvironment({ HOME: '/home/me', LC_ALL: 'C', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', AGENT_REMOTE_SESSION_TOKEN: 't', ANTHROPIC_API_KEY: 'k',
      PATH: '/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin' });
    expect(environment).toEqual({ HOME: '/home/me', LC_ALL: 'C', PATH: '/opt/homebrew/bin:/usr/bin' });
  });
});

describe('a terminal turn', () => {
  const driver = (exits: Array<{ code: number | null; errorOutput: string }>) => {
    let now = 0;
    const commands: unknown[] = [];
    const run = async (command: unknown) => { commands.push(command); now += 500; return { ...exits.shift()!, ms: 500 }; };
    return { driver: new TerminalDriver(places, () => now, run), commands };
  };
  it('runs once when the CLI takes it', async () => {
    const { driver: terminal, commands } = driver([{ code: 0, errorOutput: '' }]);
    expect(await terminal.turn('claude', 'session-1', 'Say B.')).toEqual({ provider: 'claude', delivered: true, startedAt: 0, endedAt: 500, tries: [{ t: 0, ms: 500, outcome: 'delivered', code: 0 }] });
    expect(commands).toHaveLength(1);
  });
  it("tries again while Codex says another client's turn runs, and reports what Codex said", async () => {
    const busy = { code: 1, errorOutput: 'Error: remote thread already has an active turn\n' };
    const { driver: terminal } = driver([busy, busy, { code: 0, errorOutput: '' }]);
    const turn = await terminal.turn('codex', 'thread-1', 'Say A.', { retryMs: 0 });
    expect(turn.delivered).toBe(true);
    expect(turn.tries.map(item => [item.outcome, item.reason])).toEqual([['turn-busy', 'Error: remote thread already has an active turn'], ['turn-busy', 'Error: remote thread already has an active turn'], ['delivered', undefined]]);
  });
  it('stops at the deadline, and at once for a refusal that waiting does not change', async () => {
    const busy = { code: 1, errorOutput: 'Error: remote thread already has an active turn' };
    const { driver: late } = driver([busy, busy, busy, busy]);
    expect((await late.turn('codex', 'thread-1', 'Say A.', { retryMs: 0, deadlineMs: 1000 })).tries).toHaveLength(3);
    const { driver: separate } = driver([{ code: 1, errorOutput: 'thread 01a1 already has an active writer' }]);
    expect(await separate.turn('codex', 'thread-1', 'Say A.', { retryMs: 0 })).toMatchObject({ delivered: false, tries: [{ outcome: 'writer-busy' }] });
  });
});
