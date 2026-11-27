import { describe, expect, it, vi } from 'vitest';
import { resolveLinkTarget, inferNativeSession, type TargetPorts } from './session-target.js';

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const row = (providerId: string, id: string, minutesAgo: number, title = `Title ${id}`) => ({ address: `desk/${providerId}/${id}`, providerId, title, updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString() });

function ports(answers: Record<string, unknown[] | Error>, extra: Partial<TargetPorts> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const call = vi.fn(async (request: Record<string, unknown>) => {
    calls.push(request);
    const answer = answers[request.command as string];
    if (answer instanceof Error) throw answer;
    const next = Array.isArray(answer) && answer.length > 1 ? answer.shift() : (answer as unknown[])?.[0];
    return (next ?? {}) as Record<string, unknown>;
  });
  const notes: string[] = [];
  return { calls, notes, ports: { call, env: {}, cwd: '/work/app', now: () => NOW, terminal: { interactive: false, choose: async () => undefined, note: text => { notes.push(text); } }, ...extra } as TargetPorts };
}
const failure = (code: string) => Object.assign(new Error(code), { code });

describe('a session link without an address', () => {
  it('means the calling session inside a session started by the Controller', async () => {
    const { ports: p, calls } = ports({});
    expect(await resolveLinkTarget({}, { ...p, env: { AGENT_REMOTE_SESSION_TOKEN: 'secret' } })).toBe('self');
    expect(calls).toEqual([]);
  });

  it('is a usage error elsewhere, saying how to name one', async () => {
    const { ports: p } = ports({});
    await expect(resolveLinkTarget({}, p)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('--here') });
  });
});

describe('--here', () => {
  it('is the newest session of the provider in the current directory', async () => {
    const { ports: p, calls } = ports({ list: [{ sessions: [row('pi', 'p2', 5)] }] });
    expect(await resolveLinkTarget({ here: true, providerId: 'pi' }, p)).toBe('desk/pi/p2');
    expect(calls).toEqual([{ command: 'list', cwd: '/work/app', limit: 1, providerId: 'pi' }]);
  });

  it('needs a provider outside a native CLI shell', async () => {
    const { ports: p } = ports({});
    await expect(resolveLinkTarget({ here: true }, p)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('--provider') });
  });

  it('takes the provider and the exact session from a Claude Code shell', async () => {
    const { ports: p, calls } = ports({ read: [{}] });
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '43f1dca1-ea0d-46f3-a1c6-83d3d635cd3c' };
    expect(await resolveLinkTarget({ here: true }, { ...p, env })).toBe('local/claude/43f1dca1-ea0d-46f3-a1c6-83d3d635cd3c');
    expect(calls).toEqual([{ command: 'read', target: 'local/claude/43f1dca1-ea0d-46f3-a1c6-83d3d635cd3c', limit: 0 }]);
  });

  it('takes the newest Claude session of the directory when its shell names no session, and when another provider is asked for', async () => {
    const first = ports({ list: [{ sessions: [row('claude', 'c1', 3)] }] });
    expect(await resolveLinkTarget({ here: true }, { ...first.ports, env: { CLAUDECODE: '1' } })).toBe('desk/claude/c1');
    const other = ports({ list: [{ sessions: [row('codex', 'x1', 3)] }] });
    expect(await resolveLinkTarget({ here: true, providerId: 'codex' }, { ...other.ports, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abcdefgh1' } })).toBe('desk/codex/x1');
    expect(other.calls[0]).toMatchObject({ command: 'list', providerId: 'codex' });
  });

  it('says a Claude Code session without a first message is not saved yet', async () => {
    const { ports: p } = ports({ read: new Error('x') });
    (p.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure('session_not_found'));
    await expect(resolveLinkTarget({ here: true }, { ...p, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abcdefgh1' } })).rejects.toMatchObject({ code: 'session_not_found', message: expect.stringContaining('first message') });
  });

  it('explains per provider why a directory may have no session', async () => {
    const pi = ports({ list: [{ sessions: [] }] });
    await expect(resolveLinkTarget({ here: true, providerId: 'pi' }, pi.ports)).rejects.toMatchObject({ code: 'session_not_found', message: expect.stringContaining('only after its first message') });
    const opencode = ports({ list: [{ sessions: [] }] });
    await expect(resolveLinkTarget({ here: true, providerId: 'opencode' }, opencode.ports)).rejects.toMatchObject({ code: 'session_not_found', message: expect.stringContaining('OpenCode') });
  });

  it('asks Codex to list its sessions when the last listing has none of this directory', async () => {
    const { ports: p, calls, notes } = ports({ list: [{ sessions: [] }, { sessions: [row('codex', 'th1', 1)] }] });
    expect(await resolveLinkTarget({ here: true, providerId: 'codex' }, p)).toBe('desk/codex/th1');
    expect(calls.map(call => call.refresh)).toEqual([undefined, true]);
    expect(notes).toEqual(['Asking Codex to list its sessions…']);
  });

  it('does not ask a provider that lists on its own to list again', async () => {
    const { ports: p, calls } = ports({ list: [{ sessions: [] }] });
    await expect(resolveLinkTarget({ here: true, providerId: 'copilot' }, p)).rejects.toMatchObject({ code: 'session_not_found' });
    expect(calls).toHaveLength(1);
  });

  it('reports a provider whose catalog could not be read', async () => {
    const { ports: p } = ports({ list: [{ sessions: [], unavailableProviders: ['pi'] }] });
    await expect(resolveLinkTarget({ here: true, providerId: 'pi' }, p)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('--pick', () => {
  const sessions = [row('claude', 'a', 2, 'Fix the build'), row('codex', 'b', 90, 'Plan the release'), row('pi', 'c', 3000, '')];

  it('refuses outside a terminal and lists the sessions with their addresses', async () => {
    const { ports: p, calls } = ports({ list: [{ sessions }] });
    const error = await resolveLinkTarget({ pick: true }, p).catch(error => error);
    expect(error).toMatchObject({ code: 'selection_needed' });
    expect(error.message).toContain('1. Fix the build  [claude]  2 min ago');
    expect(error.message).toContain('2. Plan the release  [codex]  2 h ago');
    expect(error.message).toContain('3. (untitled)  [pi]  2 days ago');
    expect(error.detail.sessions.map((item: { address: string }) => item.address)).toEqual(['desk/claude/a', 'desk/codex/b', 'desk/pi/c']);
    expect(calls).toEqual([{ command: 'list', cwd: '/work/app', limit: 9 }]);
  });

  it('returns the one the person chooses by number', async () => {
    const choose = vi.fn(async () => 2);
    const { ports: p } = ports({ list: [{ sessions }] }, { terminal: { interactive: true, choose, note: () => undefined } });
    expect(await resolveLinkTarget({ pick: true }, p)).toBe('desk/codex/b');
    expect(choose).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('1. Fix the build')]));
  });

  it.each([undefined, 0, 4, 1.5])('does not guess from the answer %s', async answer => {
    const { ports: p } = ports({ list: [{ sessions }] }, { terminal: { interactive: true, choose: async () => answer, note: () => undefined } });
    await expect(resolveLinkTarget({ pick: true }, p)).rejects.toMatchObject({ code: 'canceled' });
  });

  it('narrows to a provider and asks Codex to list when it has none yet', async () => {
    const { ports: p, calls } = ports({ list: [{ sessions: [] }, { sessions: [row('codex', 'b', 1)] }] }, { terminal: { interactive: true, choose: async () => 1, note: () => undefined } });
    expect(await resolveLinkTarget({ pick: true, providerId: 'codex' }, p)).toBe('desk/codex/b');
    expect(calls.map(call => [call.providerId, call.refresh])).toEqual([['codex', undefined], ['codex', true]]);
  });

  it('says so when the directory has no session', async () => {
    const { ports: p } = ports({ list: [{ sessions: [] }] });
    await expect(resolveLinkTarget({ pick: true }, p)).rejects.toMatchObject({ code: 'session_not_found' });
  });
});

describe('inferNativeSession', () => {
  it('recognizes only Claude Code, by the variables it sets', () => {
    expect(inferNativeSession({})).toBeUndefined();
    expect(inferNativeSession({ CLAUDECODE: '1' })).toEqual({ providerId: 'claude' });
    expect(inferNativeSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'a/../b' })).toEqual({ providerId: 'claude' });
    expect(inferNativeSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abcdefgh1' })).toEqual({ providerId: 'claude', nativeSessionId: 'abcdefgh1' });
  });
});
