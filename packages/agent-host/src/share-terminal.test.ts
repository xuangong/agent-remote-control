import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

async function terminal(steps: Array<{ wait: string; keys: string }>, args = ['list-sessions']) {
  const root = await mkdtemp(join(tmpdir(), 'arc-share-keys-'));
  const socket = join(root, 'control.sock');
  const calls: Record<string, unknown>[] = [];
  const summary = (id: string) => ({ providerId: 'codex', nativeSessionId: id, title: 'Same title',
    workspace: id === 'older-session' ? '/archive/project with spaces' : '/project with spaces', updatedAt: '2026-09-21T00:00:00Z', createdAt: '2026-09-21T00:00:00Z', state: 'idle' });
  const server = createServer({ allowHalfOpen: true }, client => {
    let raw = ''; client.on('data', data => { raw += data; });
    client.on('end', () => {
      const request = JSON.parse(raw); calls.push(request);
      if (request.token !== 'test-management-token') { client.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      const data = request.nativeSessionId ? { ...summary(String(request.nativeSessionId)), providerId: request.providerId } : {
        items: request.cursor ? [summary('older-session')] : Array.from({ length: 20 }, (_, index) => summary(`session-${String(index).padStart(2, '0')}`)),
        hasMore: !request.cursor, nextCursor: request.cursor ? undefined : 'older',
      };
      client.end(JSON.stringify(request.action === 'share-context'
        ? { hostId: 'host', serverUrl: 'https://agents.example', providers: args.length
          ? [{ providerId: 'codex', displayName: 'Codex' }]
          : [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude' }] }
        : { status: 200, body: JSON.stringify(data) }));
    });
  });
  let child: ReturnType<typeof spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    server.listen(socket); await once(server, 'listening');
    await writeFile(join(root, 'daemon.json'), JSON.stringify({ pid: process.pid, socket, token: 'test-management-token' }));
    child = spawn('python3', [resolve('../../scripts/fixtures/terminal-command.py'), process.execPath, resolve('dist/cli.js'), 'share', ...args], {
      env: { ...process.env, AGENT_HOST_STATE_DIR: root, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    let output = '', pending = '', step = 0;
    const receive = (data: Buffer) => {
      output += data; pending += data;
      const next = steps[step];
      if (next && pending.includes(next.wait)) { pending = ''; step += 1; child!.stdin!.write(next.keys); }
    };
    child.stdout!.on('data', receive); child.stderr!.on('data', receive);
    child.stdin!.on('error', () => {});
    deadline = setTimeout(() => { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); }, 8000);
    const [code] = await once(child, 'close');
    return { code, output, calls, steps: step };
  } finally {
    clearTimeout(deadline);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); process.kill(-child.pid, 'SIGKILL'); await closed;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it('selects a provider with arrow keys before accepting a typed native session ID', async () => {
  const result = await terminal([
    { wait: 'Provider: codex', keys: '\u001b[B' },
    { wait: 'Provider: claude', keys: '\r' },
    { wait: 'Session ID:', keys: 'native\r' },
  ], []);
  expect(result.code, result.output).toBe(0);
  expect(result.steps).toBe(3);
  expect(result.output).toContain('provider=claude&session=native');
  expect(result.output).not.toContain('Choose provider number');
});

it('uses arrow keys and Enter to share the selected identity among identical titles', async () => {
  const result = await terminal([{ wait: 'Browse: recent', keys: '\r' }, { wait: 'Session: session-00', keys: '\u001b[B' }, { wait: 'Session: session-01', keys: '\r' }]);
  expect(result.code, result.output).toBe(0);
  expect(result.steps).toBe(3);
  expect(result.output).toContain('https://agents.example/?host=host&provider=codex&session=session-01');
  expect(result.output).not.toContain('Choose session number');
  expect(result.output).not.toContain('test-management-token');
  expect(result.output).toContain('\u001b[?1049l');
  expect(result.calls.filter(call => call.nativeSessionId).map(call => call.nativeSessionId)).toEqual(['session-01']);
});

it('browses older sessions and returns to the cached newer page with keyboard choices', async () => {
  const result = await terminal([
    { wait: 'Browse: recent', keys: '\r' },
    { wait: 'Session: session-00', keys: '\u001b[F\r' },
    { wait: 'Session: older-session', keys: '\u001b[F\r' },
    { wait: 'Session: session-00', keys: '\r' },
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.steps).toBe(4);
  expect(result.output).toContain('provider=codex&session=session-00');
  expect(result.calls.filter(call => call.action === 'share-catalog' && !call.nativeSessionId)).toHaveLength(2);
});

it.each(['\u001b', 'q', '\u0003'])('cancels keyboard selection and restores the terminal with %j', async keys => {
  const result = await terminal([{ wait: 'Browse: recent', keys: '\r' }, { wait: 'Session: session-00', keys }]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('Sharing cancelled.');
  expect(result.output).toContain('\u001b[?25h');
  expect(result.output).toContain('\u001b[?1049l');
  expect(result.calls.some(call => call.nativeSessionId)).toBe(false);
  expect(result.output).not.toContain('?host=');
});

it('searches an unloaded older session and returns from text input to keyboard selection', async () => {
  const result = await terminal([
    { wait: 'Browse: recent', keys: '\r' },
    { wait: 'Session: session-00', keys: '/' },
    { wait: 'Search session title or ID', keys: 'OLDER-session\r' },
    { wait: 'Session: older-session', keys: '\r' },
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.steps).toBe(4);
  expect(result.output).toContain('provider=codex&session=older-session');
  expect(result.calls.filter(call => call.nativeSessionId).map(call => call.nativeSessionId)).toEqual(['older-session']);
});

it('searches folders then edits a session search with no results without losing keyboard input', async () => {
  const result = await terminal([
    { wait: 'Browse: recent', keys: '\u001b[B\r' },
    { wait: 'Directory: /project with spaces', keys: '/' },
    { wait: 'Search folder path', keys: 'ARCHIVE\r' },
    { wait: 'Directory: /archive/project with spaces', keys: '\r' },
    { wait: 'Session: older-session', keys: '/' },
    { wait: 'Search session title or ID', keys: 'not-found\r' },
    { wait: 'No matches', keys: '/' },
    { wait: 'Search session title or ID', keys: 'older\r' },
    { wait: 'Session: older-session', keys: '\r' },
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.steps).toBe(9);
  expect(result.output).toContain('provider=codex&session=older-session');
  expect(result.calls.filter(call => call.action === 'share-catalog' && !call.nativeSessionId)).toHaveLength(2);
});

it('cancels a search text prompt without sharing or leaving raw terminal input active', async () => {
  const result = await terminal([
    { wait: 'Browse: recent', keys: '\r' },
    { wait: 'Session: session-00', keys: '/' },
    { wait: 'Search session title or ID', keys: '\u0003' },
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('Sharing cancelled.');
  expect(result.calls.some(call => call.nativeSessionId)).toBe(false);
});
