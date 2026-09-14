import { expect, it } from 'vitest';
import { event, fixture, origin, send } from './fixture.js';

it('serves hosted assets and health, authenticates browser login, and transports Host RPC and Controller frames', async () => {
  const f = await fixture();
  expect((await f.request('/health')).status).toBe(200);
  const index = await f.request('/');
  expect(await index.text()).toContain('<meta name="agent-remote-auth" content="gateway">');
  expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect((await f.request('/index.html')).headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect((await f.request('/assets/main.js')).status).toBe(200);
  for (const path of ['/favicon.svg', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png']) {
    const asset = await f.request(path);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('asset');
  }
  expect((await f.request('/ws/remote-host', { headers: { upgrade: 'websocket' } })).status).toBe(401);
  const alice = await f.login('alice');
  expect((await f.json('/auth/session', '', { ticket: alice.ticket })).status).toBe(401);
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const { socket: host, hostId } = await f.host(pairing.key);
  expect((await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as any).hosts[0].id).toBe(hostId);
  host.addEventListener('message', message => {
    const data = JSON.parse(String(message.data));
    if (data.type === 'rpc_request') send(host, { type: 'rpc_response', requestId: data.requestId, status: 200,
      body: JSON.stringify(data.path.startsWith('/remote/catalog') ? { items: [{ nativeSessionId: 'native-1', providerId: 'codex', title: 'Private session' }], hasMore: false }
        : { agentId: 'agent-1', nativeSessionId: 'native-1' }) });
    if (data.type === 'stream_open') { send(host, { type: 'stream_opened', streamId: data.streamId }); send(host, { type: 'stream_message', streamId: data.streamId, message: JSON.stringify({ text: 'Host to browser' }) }); }
    if (data.type === 'stream_message') send(host, { type: 'stream_message', streamId: data.streamId, message: data.message });
  });
  const catalog = await f.json(alice.basePath + `v1/remote/hosts/${hostId}/catalog?providerId=codex`, alice.cookie);
  expect((await catalog.json() as any).items[0].title).toBe('Private session');
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/attach`, alice.cookie, { providerId: 'codex', nativeSessionId: 'native-1' })).status).toBe(200);
  const browser = await f.upgrade(alice.basePath + 'v1/sessions/agent-1/events', { cookie: alice.cookie, origin });
  expect(await event(browser, 'message')).toEqual({ text: 'Host to browser' });
  const echo = event(browser, 'message'); browser.send(JSON.stringify({ text: 'Browser to Host' }));
  expect(await echo).toEqual({ text: 'Browser to Host' });
  const closed = event(browser, 'close'); browser.send(new Uint8Array([1, 2, 3])); expect((await closed).code).toBe(1003);
});

it('keeps shared Host catalogs private and commits concurrent quota and unknown outcomes across replacement', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const bob = await f.login('bob');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  let host = await f.host(pairing.key); const hostId = host.hostId; let creations = 0;
  const attachHandler = () => host.socket.addEventListener('message', message => {
    const data = JSON.parse(String(message.data));
    if (data.type === 'stream_open') { send(host.socket, { type: 'stream_opened', streamId: data.streamId }); send(host.socket, { type: 'stream_message', streamId: data.streamId, message: JSON.stringify({ restored: true }) }); }
    if (data.type !== 'rpc_request') return;
    const body = data.body ? JSON.parse(data.body) : {};
    if (data.path === '/remote/create') {
      creations++;
      send(host.socket, { type: 'rpc_response', requestId: data.requestId, status: body.cwd === '/uncertain' ? 503 : 200,
        body: JSON.stringify(body.cwd === '/uncertain' ? { code: 'mutation_outcome_unknown', error: 'Native outcome unavailable' } : { agentId: 'shared-agent', nativeSessionId: 'shared-native' }) });
    } else send(host.socket, { type: 'rpc_response', requestId: data.requestId, status: 200,
      body: JSON.stringify(data.path.startsWith('/remote/catalog/session') ? { nativeSessionId: 'shared-native', providerId: 'codex', title: 'Bob topic' }
        : data.path.startsWith('/remote/catalog') ? { items: [{ nativeSessionId: 'alice-private', providerId: 'codex', title: 'Alice private' }], hasMore: false }
        : data.path === '/remote/attach' ? { agentId: 'shared-agent', nativeSessionId: 'shared-native' } : { restored: true }) });
  });
  attachHandler();
  expect((await f.json(alice.basePath + 'v1/remote/hosts', bob.cookie)).status).toBe(403);
  expect(await (await f.json(bob.basePath + 'v1/remote/hosts', bob.cookie)).json()).toEqual({ hosts: [] });
  const share = (sessionLimit: number) => f.control({ subject: 'alice', operation: 'share', hostId, targetSubject: 'bob', targetLabel: 'Bob', sessionLimit })();
  expect((await share(1)).status).toBe(200);
  expect((await f.json(bob.basePath + `v1/remote/hosts/${hostId}/attach`, bob.cookie, { providerId: 'codex', nativeSessionId: 'alice-private' })).status).toBe(403);
  const create = (requestId: string, cwd?: string) => f.json(bob.basePath + `v1/remote/hosts/${hostId}/create`, bob.cookie, { providerId: 'codex', requestId, ...(cwd ? { cwd } : {}) });
  const results = await Promise.all([create('first'), create('second')]);
  expect(results.map(response => response.status).sort()).toEqual([200, 409]); expect(creations).toBe(1);
  const firstId = results[0]!.status === 200 ? 'first' : 'second';
  expect((await create(firstId)).status).toBe(200); expect(creations).toBe(1);
  const catalog = await f.json(bob.basePath + `v1/remote/hosts/${hostId}/catalog?providerId=codex`, bob.cookie);
  expect((await catalog.json() as any).items.map((value: any) => value.title)).toEqual(['Bob topic']);
  expect((await share(2)).status).toBe(200);
  expect((await create('unknown', '/uncertain')).status).toBe(503); expect(creations).toBe(2);
  const proof = f.control({ subject: 'alice', operation: 'hosts' }); expect((await proof()).status).toBe(200);
  await f.restart();
  expect((await proof()).status).toBe(401);
  const offline = await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json() as any;
  expect(offline.hosts[0]).toMatchObject({ id: hostId, online: false });
  host = await f.host(host.key); expect(host.hostId).toBe(hostId); attachHandler();
  expect((await create(firstId)).status).toBe(200); expect(creations).toBe(2);
  expect((await (await create('unknown', '/uncertain')).json() as any).code).toBe('creation_outcome_unknown');
  expect((await (await create('third')).json() as any).code).toBe('session_quota_exceeded');
  expect(await (await f.json(bob.basePath + 'v1/sessions/shared-agent/snapshot', bob.cookie)).json()).toEqual({ restored: true });
  const restoredBrowser = await f.upgrade(bob.basePath + 'v1/sessions/shared-agent/events', { cookie: bob.cookie, origin });
  expect(await event(restoredBrowser, 'message')).toEqual({ restored: true });
  const shareClosed = event(restoredBrowser, 'close');
  expect((await f.control({ subject: 'alice', operation: 'revoke-share', hostId, targetSubject: 'bob' })()).status).toBe(200);
  expect(await (await f.json(bob.basePath + 'v1/remote/hosts', bob.cookie)).json()).toEqual({ hosts: [] });
  expect((await shareClosed).code).toBe(1008);
  expect(host.socket.readyState).toBe(1);
  expect((await share(1)).status).toBe(200);
  expect((await (await create('third')).json() as any).code).toBe('session_quota_exceeded');
  const logoutBrowser = await f.upgrade(bob.basePath + 'v1/sessions/shared-agent/events', { cookie: bob.cookie, origin });
  await event(logoutBrowser, 'message'); const loggedOut = event(logoutBrowser, 'close');
  expect((await f.json('/auth/logout', bob.cookie, {})).status).toBe(200);
  expect((await loggedOut).code).toBe(1008);
  const closed = event(host.socket, 'close');
  expect((await f.json(alice.basePath + `v1/remote/hosts/${hostId}/revoke`, alice.cookie, {})).status).toBe(200);
  expect((await closed).code).toBe(1008);
  expect((await f.request('/ws/remote-host', { headers: { upgrade: 'websocket', authorization: `Bearer ${pairing.key}` } })).status).toBe(401);
  expect((await f.json('/auth/logout', bob.cookie, {})).status).toBe(200);
  expect((await f.json('/auth/status', bob.cookie)).status).toBe(401);
});

it('binds persisted SQLite records to the deployment secret and preserves a pending browser login through replacement', async () => {
  const f = await fixture();
  const pending = await f.beginLogin('alice');
  const before = await (await f.inspect('storage')).json() as any;
  expect(before.rows).toContainEqual({ kind: 'loginChallenge', count: 1 });
  await f.restart();
  const after = await (await f.inspect('storage')).json() as any;
  expect(after.rows).toEqual(before.rows); expect(after.alarm).toBe(before.alarm);
  expect((await f.json('/auth/session', pending.loginCookie, { ticket: pending.ticket })).status).toBe(200);
  expect((await f.json('/auth/session', pending.loginCookie, { ticket: pending.ticket })).status).toBe(401);
  await f.restart('replacement-secret-that-must-not-read-existing-state');
  expect((await f.request('/auth/status')).status).toBe(503);
  expect((await f.request('/auth/login')).status).toBe(503);
});

it('preserves pending alarms, tolerates duplicate delivery, and recovers durable commits after background failure', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const before = await (await f.inspect('storage')).json() as any;
  await f.inspect('alarm'); await f.inspect('alarm');
  const duplicated = await (await f.inspect('storage')).json() as any;
  expect(duplicated.alarm).toBe(before.alarm);
  const sessionsBefore = duplicated.rows.find((row: any) => row.kind === 'session').count;
  await f.inspect('fail-commit');
  const rejected = await f.request('/auth/login');
  expect(rejected.status).toBe(503); expect(rejected.headers.getSetCookie()).toEqual([]);
  expect((await f.json('/auth/status', alice.cookie)).status).toBe(503);
  expect((await (await f.inspect('storage')).json() as any).alarm).toBeGreaterThan(Date.now());
  await expect(f.inspect('alarm')).rejects.toThrow(/refresh failed/);
  const failed = await (await f.inspect('storage')).json() as any;
  expect(failed.rows.find((row: any) => row.kind === 'session').count).toBe(sessionsBefore);
  expect(failed.alarm).toBeGreaterThan(Date.now() + 40_000);
  await f.inspect('restore-commit');
  await f.inspect('alarm-set?at=' + (Date.now() + 20));
  let restored = 503;
  for (let attempt = 0; attempt < 50 && restored !== 200; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20)); restored = (await f.json('/auth/status', alice.cookie)).status;
  }
  expect(restored).toBe(200);
  expect((await f.request('/auth/login')).status).toBe(303);
});

it('expires HTTP and socket access during a Gateway outage even without alarm delivery, then renews after recovery', async () => {
  const f = await fixture(); f.setAuthority(200, 400);
  const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const { socket, key } = await f.host(pairing.key);
  const closed = event(socket, 'close'); f.setAuthority(503);
  await new Promise(resolve => setTimeout(resolve, 500));
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'ping' }));
  expect([1008, 1013]).toContain((await closed).code);
  expect((await f.json('/auth/status', alice.cookie)).status).toBe(503);
  const before = f.authorityCalls;
  await f.inspect('alarm-set?at=' + (Date.now() + 20));
  for (let attempt = 0; attempt < 30 && f.authorityCalls === before; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.authorityCalls).toBeGreaterThan(before);
  const unavailable = await (await f.inspect('storage')).json() as any;
  expect(unavailable.alarm).toBeGreaterThan(Date.now());
  f.setAuthority(200); await f.inspect('alarm');
  expect((await f.json('/auth/status', alice.cookie)).status).toBe(200);
  expect((await f.host(key)).hostId).toBeTruthy();
});

it('rejects oversized native frames and closes registration when its asynchronous durable commit fails', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const oversized = await f.upgrade('/ws/remote-host', { authorization: `Bearer ${pairing.key}` });
  const oversizedClosed = event(oversized, 'close'); oversized.send('x'.repeat(8 * 1024 * 1024 + 1));
  expect((await oversizedClosed).code).toBe(1009);
  const registering = await f.upgrade('/ws/remote-host', { authorization: `Bearer ${pairing.key}` });
  const frames: unknown[] = []; registering.addEventListener('message', message => frames.push(message.data));
  await f.inspect('fail-commit?kind=host');
  const rejected = event(registering, 'close');
  send(registering, { type: 'register', credentialRotation: true, installationId: 'rejected-host', name: 'Rejected Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  expect([1001, 1011]).toContain((await rejected).code); expect(frames).toEqual([]);
  await f.inspect('restore-commit'); await f.inspect('alarm').catch(() => undefined); await f.inspect('alarm');
  expect(await (await f.json(alice.basePath + 'v1/remote/hosts', alice.cookie)).json()).toEqual({ hosts: [] });
  expect((await f.host(pairing.key)).hostId).toBeTruthy();
});

it('enforces the native registration deadline without incoming frames', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const socket = await f.upgrade('/ws/remote-host', { authorization: `Bearer ${pairing.key}` });
  const closed = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Registration deadline was not enforced')), 12_000);
    socket.addEventListener('close', value => { clearTimeout(timer); resolve(value); }, { once: true });
  });
  expect((await closed).code).toBe(1008);
});

it('retains a session login destination across Worker replacement', async () => {
  const f = await fixture();
  const target = '/?host=desk&provider=claude&session=native-child&parent=native-root';
  const begin = await f.request('/auth/login' + target.slice(1));
  expect(begin.status).toBe(303);
  const cookie = begin.headers.get('set-cookie')!.split(';')[0]!;
  const challenge = new URL(begin.headers.get('location')!).searchParams.get('challenge');
  const { sign, issuer } = await import('./fixture.js');
  const iat = Math.floor(Date.now() / 1000);
  const ticket = sign('arc-relay+jwt', { iss: issuer, aud: origin, sub: 'alice', nonce: challenge,
    iat, exp: iat + 900, jti: 'session-link', continuation: 'alice', sessionExpiresAt: Date.now() + 3_600_000 });
  await f.restart();
  const accepted = await f.json('/auth/session', cookie, { ticket });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ returnPath: target });
  expect((await f.json('/auth/session', cookie, { ticket })).status).toBe(401);
});
