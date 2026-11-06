import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { signedInUser, userApi } from './session.mjs';

async function fakeInstance(t, { statusCode = 200 } = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, cookie: request.headers.cookie, origin: request.headers.origin });
    if (request.url === '/auth/status') {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'set-cookie': ['devbox_session=s1; Path=/; HttpOnly', 'devbox_login=; Max-Age=0'] });
      return response.end(JSON.stringify({ user: { id: 'devbox' }, basePath: '/u/abc/' }));
    }
    if (request.url === '/u/abc/v1/remote/hosts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{"hosts":[]}');
    }
    if (request.url === '/auth/logout') { response.writeHead(204); return response.end(); }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

test('calls the user API with the local session and signs out', async t => {
  const f = await fakeInstance(t);
  assert.deepEqual(await userApi(f.origin, 'v1/remote/hosts'), { status: 200, body: '{"hosts":[]}' });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.url}`), ['GET /auth/status', 'GET /u/abc/v1/remote/hosts', 'POST /auth/logout']);
  const api = f.calls[1];
  assert.equal(api.cookie, 'devbox_session=s1; devbox_login=');
  assert.equal(api.origin, f.origin);
  assert.equal(f.calls[0].cookie, undefined);
});

test('rejects paths outside the user API', async () => {
  await assert.rejects(userApi('http://127.0.0.1:9', '/auth/status'), /start with v1\//);
});

test('reports an unavailable local identity', async t => {
  const f = await fakeInstance(t, { statusCode: 401 });
  await assert.rejects(signedInUser(f.origin), /local identity is unavailable \(401\)/);
});
