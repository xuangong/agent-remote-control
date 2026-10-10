import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { DebuggerIo } from './output.js';
const work = { id: 'work-one', revision: 1, title: 'Delivery', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09', updatedAt: '2026-10-09', nextCheckAt: 0 };
function output(files: Record<string, string> = {}) {
  const stdout: string[] = [], stderr: string[] = [];
  const io: DebuggerIo = { stdout: value => stdout.push(value), stderr: value => stderr.push(value), stdin: async () => 'Ship', readFile: async path => files[path] ?? 'Ship' };
  return { io, stdout, stderr };
}
it('runs TPM list/create/read/actions on the authorized Host path using existing session credentials', async () => {
  const calls: Array<{ path?: string; method?: string; origin?: string; cookie?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    calls.push({ path: request.url, method: request.method, origin: request.headers.origin, cookie: request.headers.cookie, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url!.endsWith('/tpm') ? { supported: true, works: [work] } : work));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = output({ cookies: '__Host-arc_session=private-session-secret' });
  const options = ['--relay', base + '/u/tenant/', '--cookie-file', 'cookies', '--origin', base, '--json'];
  try {
    for (const command of [
      ['tpm', 'list', 'host-one'], ['tpm', 'show', 'host-one', 'work-one'],
      ['tpm', 'create', 'host-one', 'Ship', '--provider', 'codex', '--main-session', 'main', '--title', 'Delivery', '--operation-id', 'create-one'],
      ...['pause', 'resume', 'check', 'reopen'].map(action => ['tpm', action, 'host-one', 'work-one', '--revision', '1', '--operation-id', action + '-one']),
      ['tpm', 'create', 'host-one', '--provider', 'codex', '--main-session', 'main', '--operation-id', 'blank-one'],
      ...['archive', 'unarchive'].map(action => ['tpm', action, 'host-one', 'work-one', '--revision', '1', '--operation-id', action + '-one']),
      ['tpm', 'rename', 'host-one', 'work-one', '--title', 'Amber Iris', '--revision', '1', '--operation-id', 'rename-one'],
      ['tpm', 'resolve', 'host-one', 'work-one', '--revision', '1', '--intent-id', 'intent-one', '--resolution', 'rejected', '--operation-id', 'resolve-one'],
    ]) expect(await runCli([...command, ...options], result.io, { subscribeSigint: () => () => {} })).toBe(0);
    expect(calls).toHaveLength(12);
    expect(calls.every(call => call.path?.startsWith('/u/tenant/v1/remote/hosts/host-one/tpm'))).toBe(true);
    expect(calls.every(call => call.cookie === '__Host-arc_session=private-session-secret' && call.origin === base)).toBe(true);
    expect(JSON.parse(calls[2]!.body)).toEqual({ providerId: 'codex', mainNativeSessionId: 'main', title: 'Delivery', requirement: 'Ship', operationId: 'create-one' });
    expect(JSON.parse(calls[3]!.body)).toEqual({ action: 'pause', revision: 1, operationId: 'pause-one', id: 'work-one' });
    expect(JSON.parse(calls[7]!.body)).toEqual({ providerId: 'codex', mainNativeSessionId: 'main', operationId: 'blank-one' });
    expect(JSON.parse(calls[8]!.body)).toMatchObject({ action: 'archive', id: 'work-one' });
    expect(JSON.parse(calls[9]!.body)).toMatchObject({ action: 'unarchive', id: 'work-one' });
    expect(JSON.parse(calls[10]!.body)).toMatchObject({ action: 'rename', title: 'Amber Iris', id: 'work-one' });
    expect(result.stdout.join('')).not.toContain('private-session-secret'); expect(result.stderr).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10000);
it('requires an expected work revision and rejects invalid cookies without exposing credentials', async () => {
  const missing = output();
  expect(await runCli(['tpm', 'pause', 'host', 'work', '--json'], missing.io, { subscribeSigint: () => () => {} })).toBe(2);
  expect(missing.stderr.join('')).toContain('revision_required');
  const secret = 'secret-cookie\r\nHost: foreign'; const bad = output({ cookies: secret });
  expect(await runCli(['tpm', 'list', 'host', '--cookie-file', 'cookies'], bad.io, { subscribeSigint: () => () => {} })).toBe(2);
  expect(bad.stderr.join('')).toContain('invalid_cookie_file'); expect(bad.stderr.join('')).not.toContain(secret);
});
it('passes an explicitly recovered native identity when resolving uncertain creation', async () => {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    expect(JSON.parse(body)).toEqual({ id: 'work-one', action: 'resolve', revision: 1, operationId: 'resolve-create', intentId: 'creation', resolution: 'accepted', nativeSessionId: 'recovered-native' });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(work));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = output();
    expect(await runCli(['tpm', 'resolve', 'host-one', 'work-one', '--relay', `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--revision', '1', '--intent-id', 'creation', '--resolution', 'accepted', '--native-session', 'recovered-native', '--operation-id', 'resolve-create'], result.io, { subscribeSigint: () => () => {} })).toBe(0);
    expect(result.stderr).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10000);
