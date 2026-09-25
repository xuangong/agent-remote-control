import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(purpose: 'host-only' | 'gateway-setup' | 'legacy' = 'gateway-setup') {
  const root = await mkdtemp(join(tmpdir(), 'arc-bootstrap-cli-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const apiKey = 'sk_bootstrap_private_llm_credential'; const deviceKey = 'arc_device_saved_credential';
  const sequence: string[] = []; const registrations: Array<{ installationId: string; providers: unknown[]; key?: string }> = [];
  let status = 200; let nativeFails = false; let child: ChildProcess | undefined; let output = ''; let bootstrapKey: string | undefined;
  const server = createServer(async (request, response) => {
    request.resume();
    if (request.url !== '/v1/remote/host/bootstrap') { response.writeHead(404); response.end(); return; }
    bootstrapKey = request.headers.authorization;
    const persisted = JSON.parse(await readFile(join(root, 'connection.json'), 'utf8'));
    expect(persisted.remoteKey).toBe(deviceKey);
    sequence.push('bootstrap');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { apiKey, keyId: 'key-host', baseUrl: 'https://gateway.example/v1', model: 'codex-test' } : { error: apiKey }));
  });
  let registrationDelay = 0;
  const sendRegistered = (socket: WebSocket) => {
    const delay = registrationDelay; registrationDelay = 0;
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host-cli', ...(purpose !== 'legacy' ? { pairingPurpose: purpose } : {}), heartbeat: { intervalMs: 30000, timeoutMs: 10000 } })); }, delay);
  };
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    socket.on('message', async raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'register') {
        registrations.push({ installationId: message.installationId, providers: message.providers, key: request.headers.authorization });
        sequence.push(message.providers.length ? 'providers' : 'enrollment');
        if (request.headers.authorization === 'Bearer invitation') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_issued', credential: deviceKey }));
        else sendRegistered(socket);
      } else if (message.type === 'credential_saved') {
        expect(JSON.parse(await readFile(join(root, 'connection.json'), 'utf8')).remoteKey).toBe(deviceKey);
        sendRegistered(socket);
      }
    });
    socket.on('close', () => sequence.push('closed'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
  const claudeExecutable = join(root, 'native-claude');
  await writeFile(claudeExecutable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_CLAUDE_CAPTURE, JSON.stringify({ home: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL, codexKey: process.env.CODEX_GATEWAY_API_KEY })); console.log('2.1.247 (Claude Code)');\n`, { mode: 0o700 });
  const executable = join(root, 'native-codex');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const config = process.env.CODEX_HOME ? fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8') : undefined; fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({home:process.env.CODEX_HOME,key:process.env.CODEX_GATEWAY_API_KEY,config})); console.log(process.env.TEST_NATIVE_FAIL ? process.env.CODEX_GATEWAY_API_KEY : 'codex-cli 0.155.0');\n`, { mode: 0o700 });
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
  cleanups.push(stop);
  const start = (overrides: NodeJS.ProcessEnv = {}, saved = false, command = 'foreground') => {
    output = '';
    child = spawn(process.execPath, ['dist/cli.js', command], { env: {
      PATH: process.env.PATH, HOME: root, AGENT_HOST_STATE_DIR: root, AGENT_HOST_WORKSPACE: root, AGENT_HOST_CODEX: executable, ...(saved ? {} : { AGENT_HOST_CLAUDE: join(root, 'missing-claude') }), AGENT_HOST_COPILOT: join(root, 'missing-copilot'), AGENT_HOST_OPENCODE_URL: 'http://127.0.0.1:1', TEST_CLAUDE_CAPTURE: join(root, 'claude-native.json'),
      TEST_CAPTURE: join(root, 'native.json'), ...(nativeFails ? { TEST_NATIVE_FAIL: '1' } : {}),
      ...(saved ? {} : { AGENT_HOST_SERVER: `http://127.0.0.1:${address.port}`, AGENT_HOST_REMOTE_KEY: 'invitation' }), ...overrides,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
    return child;
  };
  return { root, claudeExecutable, start, stop, apiKey, deviceKey, sequence, registrations, sockets, serverUrl: `http://127.0.0.1:${address.port}`, get output() { return output; }, get bootstrapKey() { return bootstrapKey; },
    delayNextRegistration: (delay: number) => { registrationDelay = delay; }, setPurpose: (value: 'host-only' | 'gateway-setup' | 'legacy') => { purpose = value; }, failBootstrap: () => { status = 503; }, failNative: () => { nativeFails = true; } };
}

it('enrolls and saves the device before configuring Codex, then registers providers using the rotated credential', async () => {
  const f = await fixture(); f.start();
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.sequence).toEqual(['enrollment', 'bootstrap', 'closed', 'providers']);
  expect(f.bootstrapKey).toBe('Bearer ' + f.deviceKey);
  expect(f.registrations.map(value => value.key)).toEqual(['Bearer invitation', 'Bearer ' + f.deviceKey]);
  expect(f.registrations[0]?.installationId).toBe(f.registrations[1]?.installationId);
  const native = JSON.parse(await readFile(join(f.root, 'native.json'), 'utf8'));
  expect(native.home).toBe(join(f.root, 'gateway-codex')); expect(native.key).toBe(f.apiKey);
  expect(native.config).toContain('wire_api = "responses"');
  expect(f.output).not.toContain(f.apiKey);
  await f.stop(); f.start({}, true);
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  const saved = JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8'));
  expect(saved.pairingPurpose).toBe('gateway-setup'); expect(saved.environment.AGENT_HOST_GATEWAY_SETUP).toBe('1');
  expect(f.registrations.slice(-2).map(value => value.key)).toEqual(['Bearer ' + f.deviceKey, 'Bearer ' + f.deviceKey]);
}, 15000);

it('closes enrollment on bootstrap failure while retaining the new device credential for retry', async () => {
  const f = await fixture(); f.failBootstrap(); const child = f.start();
  expect((await once(child, 'exit'))[0]).toBe(1);
  expect(f.registrations).toHaveLength(1);
  expect(f.sequence).toContain('closed');
  expect(JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8')).remoteKey).toBe(f.deviceKey);
  expect(f.output).not.toContain(f.apiKey);
}, 10000);

it('rejects unrelated native state after enrolling and redacts a provisioned key from startup errors', async () => {
  const f = await fixture(); let child = f.start({ CODEX_HOME: join(f.root, 'user-codex') });
  expect((await once(child, 'exit'))[0]).toBe(1); expect(f.registrations).toHaveLength(1);
  child = f.start({ CODEX_HOME: '', AGENT_HOST_CODEX_CONNECTION: 'typo' }, true);
  expect((await once(child, 'exit'))[0]).toBe(1); expect(f.registrations).toHaveLength(2);
  f.failNative(); f.start({ CODEX_HOME: '', AGENT_HOST_CODEX_CONNECTION: 'private' }, true);
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.registrations.at(-1)?.providers).toEqual([]);
  expect(f.output).not.toContain(f.apiKey);
  expect(f.output).toContain('unavailable');
}, 15000);


it('rejects managed live pairing on the authenticated management socket without replacing the connection', async () => {
  const f = await fixture(); f.start({}, false, '_serve');
  let state: { token: string; socket: string };
  await vi.waitFor(async () => {
    state = JSON.parse(await readFile(join(f.root, 'daemon.json'), 'utf8'));
    expect(f.registrations).toHaveLength(2);
    // Registration reaches the fixture before the daemon persists its initialized environment.
    const saved = JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8'));
    expect(saved.environment.CODEX_HOME).toBe(join(f.root, 'gateway-codex'));
  }, { timeout: 5000 });
  const connection = await readFile(join(f.root, 'connection.json'), 'utf8');
  const credentials = await readFile(join(f.root, 'gateway-codex', 'gateway-credentials.json'), 'utf8');
  const result = await new Promise<{ error?: string }>((resolve, reject) => {
    const socket = createConnection(state.socket); let response = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Management response timed out')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify({ token: state.token, action: 'pair', server: f.serverUrl, key: 'other-account-device' })));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('end', () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
  expect(result.error).toMatch(/Gateway.*new.*AGENT_HOST_STATE_DIR/i);
  expect(f.registrations).toHaveLength(2);
  expect(await readFile(join(f.root, 'connection.json'), 'utf8')).toBe(connection);
  expect(await readFile(join(f.root, 'gateway-codex', 'gateway-credentials.json'), 'utf8')).toBe(credentials);
}, 10000);

it('rejects the pair command for saved managed state even when the caller disables bootstrap', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'connection.json'), JSON.stringify({ serverUrl: f.serverUrl, remoteKey: f.deviceKey,
    environment: { AGENT_HOST_BOOTSTRAP_CODEX: '1' } }));
  const connection = await readFile(join(f.root, 'connection.json'), 'utf8');
  await expect(promisify(execFile)(process.execPath, ['dist/cli.js', 'pair'], { timeout: 5000, env: {
    HOME: f.root, PATH: process.env.PATH, AGENT_HOST_STATE_DIR: f.root, AGENT_HOST_SERVER: f.serverUrl,
    AGENT_HOST_REMOTE_KEY: 'other-account-device', AGENT_HOST_BOOTSTRAP_CODEX: '0',
  } })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Gateway.*new.*AGENT_HOST_STATE_DIR/i) });
  expect(f.registrations).toHaveLength(0);
  expect(await readFile(join(f.root, 'connection.json'), 'utf8')).toBe(connection);
}, 10000);

for (const purpose of ['host-only', 'legacy'] as const) {
  it(`preserves native Codex configuration and never bootstraps when Relay purpose is ${purpose}`, async () => {
    const f = await fixture(purpose);
    const nativeHome = join(f.root, 'native-home');
    await import('node:fs/promises').then(fs => fs.mkdir(nativeHome));
    const config = 'model = "native-personal-model"\n';
    await writeFile(join(nativeHome, 'config.toml'), config);
    f.start({ CODEX_HOME: nativeHome, AGENT_HOST_BOOTSTRAP_CODEX: '1' });
    await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
    expect(f.sequence).toEqual(['enrollment', 'closed', 'providers']);
    expect(f.bootstrapKey).toBeUndefined();
    const native = JSON.parse(await readFile(join(f.root, 'native.json'), 'utf8'));
    expect(native.home).toBe(nativeHome); expect(native.config).toBe(config); expect(native.key).toBeUndefined();
    expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toBe(config);
    const saved = JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8'));
    expect(saved.pairingPurpose).toBe('host-only');
    expect(saved.environment.AGENT_HOST_BOOTSTRAP_CODEX).toBeUndefined();
    expect(saved.remoteKey).toBe(f.deviceKey);
  }, 10000);
}

it('initializes the selected Claude adapter without starting Codex and restores its setup on restart', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'provider-settings.json'), JSON.stringify({ disabled: ['codex'] }));
  f.start({ AGENT_HOST_PROVIDERS: 'claude', AGENT_HOST_CLAUDE: f.claudeExecutable });
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.sequence).toEqual(['enrollment', 'bootstrap', 'closed', 'providers']);
  expect(f.registrations[1]?.providers).toEqual([expect.objectContaining({ providerId: 'claude' })]);
  const native = JSON.parse(await readFile(join(f.root, 'claude-native.json'), 'utf8'));
  expect(native).toMatchObject({ home: join(f.root, 'gateway-claude'), key: f.apiKey, base: 'https://gateway.example', model: 'codex-test' });
  expect(native.codexKey).toBeUndefined();
  await expect(readFile(join(f.root, 'native.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.output).not.toContain(f.apiKey);
  await f.stop(); f.start({}, true);
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.registrations.slice(-1)[0]?.providers).toEqual([expect.objectContaining({ providerId: 'claude' })]);
}, 15000);

it('rejects unsupported Gateway provider selection after enrollment and before token provisioning', async () => {
  const f = await fixture(); const child = f.start({ AGENT_HOST_PROVIDERS: 'copilot' });
  expect((await once(child, 'exit'))[0]).toBe(1);
  expect(f.sequence).toEqual(['enrollment', 'closed']); expect(f.bootstrapKey).toBeUndefined();
  expect(f.output).toMatch(/copilot.*not supported/);
  expect(JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8')).remoteKey).toBe(f.deviceKey);
}, 10000);

it('saves a live pairing that requires Gateway setup and stops before exposing existing providers to it', async () => {
  const f = await fixture('host-only'); const child = f.start({}, false, '_serve');
  await vi.waitFor(async () => { await readFile(join(f.root, 'daemon.json')); expect(f.registrations).toHaveLength(2); }, { timeout: 5000 });
  f.setPurpose('gateway-setup');
  const exited = once(child, 'exit');
  const result = await promisify(execFile)(process.execPath, ['dist/cli.js', 'pair'], { timeout: 5000, env: {
    HOME: f.root, PATH: process.env.PATH, AGENT_HOST_STATE_DIR: f.root, AGENT_HOST_SERVER: f.serverUrl, AGENT_HOST_REMOTE_KEY: 'invitation',
  } });
  expect(result.stdout).toMatch(/restart.*initializ/i);
  await exited;
  expect(f.registrations).toHaveLength(3); expect(f.registrations[2]?.providers).toEqual([]);
  expect(f.bootstrapKey).toBeUndefined();
  const saved = JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8'));
  expect(saved.pairingPurpose).toBe('gateway-setup'); expect(saved.environment.AGENT_HOST_GATEWAY_SETUP).toBe('1');
  expect(saved.remoteKey).toBe(f.deviceKey);
  f.start({}, true);
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.bootstrapKey).toBe('Bearer ' + f.deviceKey);
}, 15000);

it('keeps the daemon and its native providers running when live pairing remains host-only', async () => {
  const f = await fixture('host-only'); f.start({}, false, '_serve');
  let before: string;
  await vi.waitFor(async () => { before = await readFile(join(f.root, 'daemon.json'), 'utf8'); expect(f.registrations).toHaveLength(2); }, { timeout: 5000 });
  const result = await promisify(execFile)(process.execPath, ['dist/cli.js', 'pair'], { timeout: 5000, env: {
    HOME: f.root, PATH: process.env.PATH, AGENT_HOST_STATE_DIR: f.root, AGENT_HOST_SERVER: f.serverUrl, AGENT_HOST_REMOTE_KEY: 'invitation',
  } });
  expect(result.stdout).toContain('without restarting sessions');
  expect(await readFile(join(f.root, 'daemon.json'), 'utf8')).toBe(before!);
  expect(f.registrations).toHaveLength(4); expect(f.registrations[2]?.providers).toEqual([]);
  expect(f.registrations[3]?.providers).toEqual([expect.objectContaining({ providerId: 'codex' })]);
  expect(f.bootstrapKey).toBeUndefined();
}, 10000);

it('waits for a slow live pairing enrollment instead of timing out after the key is consumed', async () => {
  const f = await fixture('host-only'); f.start({}, false, '_serve');
  await vi.waitFor(async () => { await readFile(join(f.root, 'daemon.json')); expect(f.registrations).toHaveLength(2); }, { timeout: 5000 });
  f.delayNextRegistration(6000);
  const result = await promisify(execFile)(process.execPath, ['dist/cli.js', 'pair'], { timeout: 12000, env: {
    HOME: f.root, PATH: process.env.PATH, AGENT_HOST_STATE_DIR: f.root, AGENT_HOST_SERVER: f.serverUrl, AGENT_HOST_REMOTE_KEY: 'invitation',
  } });
  expect(result.stdout).toContain('without restarting sessions');
  expect(f.registrations.length).toBeGreaterThanOrEqual(4);
  expect(f.registrations.at(-1)?.providers).toEqual([expect.objectContaining({ providerId: 'codex' })]);
  expect(JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8')).remoteKey).toBe(f.deviceKey);
}, 15000);

it('exposes sharing identity only through the authenticated local socket without native session attachment', async () => {
  const f = await fixture('host-only'); f.start({}, false, '_serve');
  let state: { token: string; socket: string };
  await vi.waitFor(async () => {
    state = JSON.parse(await readFile(join(f.root, 'daemon.json'), 'utf8'));
    expect(f.registrations).toHaveLength(2);
  }, { timeout: 5000 });
  async function local(payload: Record<string, unknown>) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(state.socket); let output = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Test management timeout')));
      socket.on('error', reject); socket.on('connect', () => socket.end(JSON.stringify(payload)));
      socket.on('data', chunk => { output += chunk; });
      socket.on('close', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
  }
  expect(await local({ action: 'share-context', token: 'wrong' })).toEqual({ error: 'Unauthorized local management request.' });
  const context = await local({ action: 'share-context', token: state!.token });
  expect(context).toMatchObject({ hostId: 'host-cli', serverUrl: f.serverUrl, providers: [{ providerId: 'codex' }] });
  expect(Object.keys(context).sort()).toEqual(['hostId', 'providers', 'serverUrl']);
  expect(await local({ action: 'share-catalog', token: state!.token, hostId: 'host-cli', providerId: 'codex', serverUrl: 'https://wrong.example' }))
    .toEqual({ error: 'The Host connection changed. Run share again.' });
  expect(await local({ action: 'share-catalog', token: state!.token, hostId: 'host-cli', providerId: 'disabled', serverUrl: f.serverUrl }))
    .toMatchObject({ status: 403 });
  expect(f.registrations).toHaveLength(2);
}, 10000);


it('discovers another installed agent on a Host whose saved provider selection is codex', async () => {
  const f = await fixture('host-only');
  f.start({ AGENT_HOST_PROVIDERS: 'codex', AGENT_HOST_CLAUDE: f.claudeExecutable });
  await vi.waitFor(() => expect(f.output).toContain('uplink is registered'), { timeout: 5000 });
  expect(f.registrations.at(-1)?.providers).toHaveLength(2);
  expect(f.registrations.at(-1)?.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerId: 'codex' }), expect.objectContaining({ providerId: 'claude' }),
  ]));
  expect(f.bootstrapKey).toBeUndefined();
  expect(JSON.parse(await readFile(join(f.root, 'claude-native.json'), 'utf8')).key).toBeUndefined();
}, 10000);
