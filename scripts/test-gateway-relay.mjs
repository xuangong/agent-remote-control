import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const gateway = process.env.AGENT_REMOTE_GATEWAY_CHECKOUT;
if (!gateway) throw new Error('Set AGENT_REMOTE_GATEWAY_CHECKOUT to the gateway worktree.');
const require = createRequire(join(root, 'packages/agent-remote-lab/package.json'));
const { chromium } = require('@playwright/test');
const { WebSocket } = require('ws');
const temporary = await mkdtemp(join(tmpdir(), 'agent-remote-gateway-'));
const processes = [];
const sockets = [];
let browser;
const logs = [];
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  child.on('error', error => { child.startupError = error; });
  child.stdout.on('data', value => logs.push(value.toString()));
  child.stderr.on('data', value => logs.push(value.toString()));
  return child;
}
function stop(signal = 'SIGTERM') { for (const child of processes) { try { process.kill(-child.pid, signal); } catch { /* Process already exited. */ } } }
const deadline = setTimeout(() => { stop('SIGKILL'); process.stderr.write('Gateway Relay test exceeded 90 seconds.\n'); process.exit(124); }, 90_000);
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function ready(file, child) {
  for (let i = 0; i < 150; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* Startup is still running. */ }
    if (child.startupError) throw child.startupError;
    if (child.exitCode !== null) throw new Error('Fixture exited before readiness.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture startup exceeded 15 seconds.');
}
try {
  const relayPort = await port(); const gatewayPort = await port();
  const relayUrl = `http://127.0.0.1:${relayPort}`; const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const env = { AGENT_REMOTE_RELAY_URL: relayUrl, AGENT_REMOTE_ISSUER: gatewayUrl, AGENT_REMOTE_SIGNING_SECRET: randomBytes(32).toString('base64url') };
  const gatewayReady = join(temporary, 'gateway.json');
  const issuer = launch('bun', ['packages/gateway/tests/fixtures/agent-remote-gateway.ts'], join(gateway, 'vnext'), { ...env, PORT: String(gatewayPort), AGENT_REMOTE_READY_FILE: gatewayReady });
  await ready(gatewayReady, issuer);
  const relayReady = join(temporary, 'relay.json');
  let relay = launch(process.execPath, ['--import', 'tsx/esm', 'src/server/gateway.ts'], join(root, 'packages/agent-remote-lab'), { ...env, AGENT_REMOTE_PORT: String(relayPort), AGENT_REMOTE_READY_FILE: relayReady, AGENT_REMOTE_STATE_DIR: join(temporary, 'state') });
  await ready(relayReady, relay);
  browser = await chromium.launch({ headless: true, ...(process.env.AGENT_REMOTE_TEST_BROWSER ? { executablePath: process.env.AGENT_REMOTE_TEST_BROWSER } : {}) });
  const context = await browser.newContext(); const page = await context.newPage();
  page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(15_000);
  await page.goto(relayUrl);
  await page.getByRole('link', { name: 'Sign in through gateway' }).waitFor();
  await context.addCookies([{ name: 'session_token', value: 'ses_agent_remote_alice', url: gatewayUrl }]);
  await page.goto(gatewayUrl + '/agent-remote');
  await page.waitForURL(relayUrl + '/');
  await page.getByRole('button', { name: 'Pair Agent Host', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  const state = await page.evaluate(async () => (await fetch('/auth/status')).json());
  const pairing = await page.evaluate(async base => (await fetch(base + 'v1/remote/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(), state.basePath);
  assert.equal(pairing.serverUrl, relayUrl);
  async function connectHost() {
    const host = new WebSocket(relayUrl.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pairing.key}` } }); sockets.push(host);
    await once(host, 'open'); const registered = once(host, 'message');
    host.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'integration-host', name: 'Integration Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
    const hostId = JSON.parse((await registered)[0].toString()).hostId;
    host.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'rpc_request') return;
      const body = message.path.startsWith('/remote/catalog/revision') ? { revision: '1' }
        : message.path.startsWith('/remote/catalog') ? { items: [{ nativeSessionId: 'test-native', providerId: 'codex', title: 'Private test session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'idle' }], revision: '1', hasMore: false }
        : message.path === '/remote/attach' ? { agentId: 'test-agent', nativeSessionId: 'test-native' }
        : message.path.startsWith('/v1/sessions/') ? { restored: true }
        : message.path.startsWith('/remote/workspaces') ? { workspaces: [] } : { models: [] };
      host.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200, body: JSON.stringify(body) }));
    });
    return { host, hostId };
  }
  const { hostId } = await connectHost();
  await page.reload();
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const hosts = await page.evaluate(async base => (await fetch(base + 'v1/remote/hosts')).json(), state.basePath);
  assert.equal(hosts.hosts[0].id, hostId);
  await page.locator('#remote-host').selectOption(hostId);
  await page.getByText('Private test session', { exact: true }).first().waitFor();
  const bob = await browser.newContext(); const other = await bob.newPage(); other.setDefaultTimeout(10_000);
  await bob.addCookies([{ name: 'session_token', value: 'ses_agent_remote_bob', url: gatewayUrl }]);
  await other.goto(gatewayUrl + '/agent-remote'); await other.waitForURL(relayUrl + '/');
  const isolation = await other.evaluate(async alicePath => {
    const own = await (await fetch('/auth/status')).json();
    return { own: await (await fetch(own.basePath + 'v1/remote/hosts')).json(), forbidden: (await fetch(alicePath + 'v1/remote/hosts')).status, basePath: own.basePath };
  }, state.basePath);
  assert.deepEqual(isolation.own, { hosts: [] }); assert.equal(isolation.forbidden, 403); assert.notEqual(isolation.basePath, state.basePath);
  const cookies = await context.cookies(relayUrl); const session = cookies.find(cookie => cookie.name === 'arc_session');
  assert.equal(session?.httpOnly, true); assert.equal(session?.sameSite, 'Strict');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.equal(storage.includes(session.value), false);
  const forwarded = await fetch(gatewayUrl + '/api/agent-remote/launch', { method: 'POST', headers: { authorization: 'Bearer ses_agent_remote_bob', 'content-type': 'application/json' }, body: JSON.stringify({ challenge: 'n'.repeat(43) }) });
  assert.equal(forwarded.status, 200);
  const { launchUrl } = await forwarded.json();
  await page.goto(launchUrl);
  await page.getByText('Access expired or invalid. Return to the gateway to sign in.', { exact: true }).waitFor();
  const retained = await page.evaluate(async () => (await fetch('/auth/status')).json());
  assert.equal(retained.basePath, state.basePath, 'A forwarded grant must not switch the victim account');
  await page.goto(relayUrl);
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const refreshed = await page.evaluate(async () => { const response = await fetch('/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: response.status, value: await response.json() }; });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.value.basePath, state.basePath);
  const attached = await page.evaluate(async ({ base, hostId }) => (await fetch(base + `v1/remote/hosts/${hostId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'test-native' }) })).json(), { base: state.basePath, hostId });
  assert.equal(attached.agentId, 'test-agent');
  const exited = once(relay, 'exit'); process.kill(-relay.pid, 'SIGTERM'); await exited;
  await rm(relayReady, { force: true });
  relay = launch(process.execPath, ['--import', 'tsx/esm', 'src/server/gateway.ts'], join(root, 'packages/agent-remote-lab'), { ...env, AGENT_REMOTE_PORT: String(relayPort), AGENT_REMOTE_READY_FILE: relayReady, AGENT_REMOTE_STATE_DIR: join(temporary, 'state') });
  await ready(relayReady, relay);
  const restored = await connectHost(); assert.equal(restored.hostId, hostId);
  await page.reload();
  await page.getByRole('option', { name: 'Integration Host · Online', exact: true }).waitFor({ state: 'attached' });
  const snapshot = await page.evaluate(async base => (await fetch(base + 'v1/sessions/test-agent/snapshot')).json(), state.basePath);
  assert.deepEqual(snapshot, { restored: true });
  await page.screenshot({ path: join(temporary, 'controller.png'), fullPage: true });
  await page.locator('#remote-host').selectOption(hostId);
  await page.getByRole('button', { name: 'Revoke Host', exact: true }).click();
  const hostClosed = once(restored.host, 'close');
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click(); await hostClosed;
  const revoked = await page.evaluate(async base => (await fetch(base + 'v1/remote/hosts')).json(), state.basePath);
  assert.deepEqual(revoked, { hosts: [] });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in through gateway' }).waitFor();
  await bob.close(); await context.close();
  console.log('PASS: real gateway SQLite auth -> callback -> HttpOnly cookie -> controller -> Host catalog; two browser users isolated; forwarded login grant rejected; renewal, process restart with stable device/binding, device revoke and logout verified. No CLI agents started.');
  console.log(`Evidence: ${temporary}`);
} catch (error) {
  await writeFile(join(temporary, 'failure.log'), logs.join(''));
  if (browser) { try { await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(temporary, 'failure.png'), fullPage: true }); } catch { /* Browser may already be closed. */ } }
  console.error(error); console.error(`Fixture diagnostics: ${temporary}`); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  stop(); await browser?.close();
  await Promise.all(processes.map(child => child.exitCode !== null ? undefined : Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])));
  stop('SIGKILL'); clearTimeout(deadline);
}
