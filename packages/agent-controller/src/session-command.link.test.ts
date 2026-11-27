import { describe, expect, it, vi } from 'vitest';
import type { CommandChannel } from './command-client.js';
import { runSessionCommand, sessionRequest, type SessionCommandIO } from './session-command.js';

describe('session link arguments', () => {
  it('takes an address, with an optional bot name after it', async () => {
    expect(await sessionRequest(['link', 'desk/claude/a'])).toMatchObject({ command: 'link', target: 'desk/claude/a' });
    expect(await sessionRequest(['link', 'desk/claude/a', '--bot'])).toMatchObject({ target: 'desk/claude/a', use: { kind: 'bot' } });
    expect((await sessionRequest(['link', 'desk/claude/a', '--bot'])).use).toEqual({ kind: 'bot' });
    expect((await sessionRequest(['link', 'desk/claude/a', '--bot', 'Reuse test'])).use).toEqual({ kind: 'bot', name: 'Reuse test' });
    expect((await sessionRequest(['link', 'desk/claude/a', '--bot=Reuse test', '--qr'])).use).toEqual({ kind: 'bot', name: 'Reuse test' });
    expect((await sessionRequest(['link', '--bot', '--qr', 'desk/claude/a'])).use).toEqual({ kind: 'bot' });
  });

  it('keeps here, pick and the provider for the Controller-side choice', async () => {
    expect(await sessionRequest(['link', '--here', '--provider', 'pi', '--bot', 'X'])).toEqual({ command: 'link', here: true, providerId: 'pi', use: { kind: 'bot', name: 'X' } });
    expect(await sessionRequest(['link', '--pick'])).toEqual({ command: 'link', pick: true });
    expect(await sessionRequest(['link'])).toEqual({ command: 'link' });
  });

  it.each([
    [['link', 'desk/claude/a', '--here']], [['link', 'desk/claude/a', '--pick']], [['link', '--here', '--pick']],
    [['link', 'desk/claude/a', '--provider', 'pi']], [['link', '--window']], [['link', '--here=1']], [['link', '--bot', 'a', '--bot', 'b']],
  ])('refuses %j', async args => {
    await expect(sessionRequest(args)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('lists by directory and refresh', async () => {
    expect(await sessionRequest(['list', '--provider', 'codex', '--cwd', '/work', '--refresh'])).toEqual({ command: 'list', providerId: 'codex', cwd: '/work', refresh: true });
  });
});

describe('session link', () => {
  function run(args: string[], answers: (request: Record<string, unknown>) => Record<string, unknown>, extra: Partial<SessionCommandIO> = {}, env: NodeJS.ProcessEnv = {}) {
    const requests: Array<Record<string, unknown>> = [];
    const channel: CommandChannel = { caller: 'owner', call: async (_scope, request) => { requests.push(request); const result = answers(request); return 'error' in result ? result as never : { result }; } };
    let output = '';
    return { requests, output: () => JSON.parse(output), code: runSessionCommand(args, env, text => { output += text; }, { channel, cwd: '/work/app', ...extra }) };
  }
  const linkOf = (request: Record<string, unknown>) => ({ session: { address: request.target }, url: `https://arc.example/?as=${(request.use as { kind: string } | undefined)?.kind ?? 'none'}` });

  it('sends an address with its use, and draws the QR beside the JSON', async () => {
    const qr = vi.fn(async () => undefined);
    const call = run(['link', 'desk/claude/a', '--bot', 'N', '--qr'], linkOf, { qr });
    expect(await call.code).toBe(0);
    expect(call.requests).toEqual([{ command: 'link', target: 'desk/claude/a', use: { kind: 'bot', name: 'N' } }]);
    expect(qr).toHaveBeenCalledWith('https://arc.example/?as=bot');
    expect(call.output().url).toBe('https://arc.example/?as=bot');
  });

  it('means the calling session inside a session shell', async () => {
    const call = run(['link', '--bot'], linkOf, {}, { AGENT_REMOTE_SESSION_TOKEN: 't' });
    expect(await call.code).toBe(0);
    expect(call.requests).toEqual([{ command: 'link', target: 'self', use: { kind: 'bot' } }]);
  });

  it('opens the newest session of this directory with --here', async () => {
    const call = run(['link', '--here', '--provider', 'pi'], request => request.command === 'list'
      ? { sessions: [{ address: 'desk/pi/p1', providerId: 'pi', title: 'T', updatedAt: '2026-11-28T00:00:00Z' }] } : linkOf(request));
    expect(await call.code).toBe(0);
    expect(call.requests).toEqual([{ command: 'list', cwd: '/work/app', limit: 1, providerId: 'pi' }, { command: 'link', target: 'desk/pi/p1' }]);
  });

  it('refuses --pick outside a terminal with the list, exit 1', async () => {
    const call = run(['link', '--pick'], () => ({ sessions: [{ address: 'desk/pi/p1', providerId: 'pi', title: 'Fix', updatedAt: '2026-11-28T00:00:00Z' }] }));
    expect(await call.code).toBe(1);
    expect(call.output()).toMatchObject({ error: { code: 'selection_needed' }, sessions: [{ address: 'desk/pi/p1' }] });
    expect(call.requests.map(request => request.command)).toEqual(['list']);
  });

  it('chooses by number with --pick in a terminal', async () => {
    const call = run(['link', '--pick'], request => request.command === 'list'
      ? { sessions: [{ address: 'desk/pi/p1', providerId: 'pi', title: 'A', updatedAt: '2026-11-28T00:00:00Z' }, { address: 'desk/claude/c1', providerId: 'claude', title: 'B', updatedAt: '2026-11-28T00:00:00Z' }] } : linkOf(request),
      { terminal: { interactive: true, choose: async () => 2, note: () => undefined } });
    expect(await call.code).toBe(0);
    expect(call.requests.at(-1)).toEqual({ command: 'link', target: 'desk/claude/c1' });
  });

  it('names the error when the directory has no session', async () => {
    const call = run(['link', '--here', '--provider', 'pi'], () => ({ sessions: [] }));
    expect(await call.code).toBe(1);
    expect(call.output().error.message).toContain('first message');
  });
});
