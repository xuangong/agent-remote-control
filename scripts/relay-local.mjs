import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { localRelayConfiguration, composeEnvironment } from './relay-local-config.mjs';

const root = resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  runtime: { type: 'string' }, 'gateway-image': { type: 'string' },
  'gateway-port': { type: 'string' }, 'relay-port': { type: 'string' }, build: { type: 'boolean', default: false },
} });
const action = positionals[0] ?? 'up';
if (!['up', 'down', 'status'].includes(action) || positionals.length > 1 || !['node', 'workers'].includes(values.runtime)) {
  throw new Error('Usage: node scripts/relay-local.mjs up|down|status --runtime node|workers [--gateway-image IMAGE] [--build]');
}
const directory = join(root, '.runtime', `relay-${values.runtime}`);
const settings = join(directory, 'settings.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
let previous;
try { previous = JSON.parse(await readFile(settings, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
if (action !== 'up' && !previous) throw new Error('This runtime has no saved local deployment. Start it with up first.');
const config = localRelayConfiguration({ runtime: values.runtime,
  gatewayPort: values['gateway-port'] ?? previous?.gatewayPort ?? await freePort(),
  relayPort: values['relay-port'] ?? previous?.relayPort ?? await freePort(),
  gatewayImage: values['gateway-image'] ?? process.env.AGENT_REMOTE_GATEWAY_IMAGE ?? previous?.gatewayImage,
  secret: previous?.secret ?? randomBytes(32).toString('base64url'),
});
if (previous && ['gatewayUrl', 'relayUrl'].some(name => previous[name] !== config[name])) {
  throw new Error('Saved Relay origins cannot change implicitly. Stop and explicitly archive its state/config before choosing new ports.');
}
await writeFile(settings, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
const envFile = join(directory, '.env'); await writeFile(envFile, composeEnvironment(config), { mode: 0o600 });
async function run(command, args, timeoutMs) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', detached: true });
  const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
  const onTerm = () => kill('SIGTERM'); const onInt = () => kill('SIGINT');
  const deadline = setTimeout(() => kill('SIGKILL'), timeoutMs);
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => {
    clearTimeout(deadline); process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
  });
  if (code !== 0) process.exit(code ?? 1);
}
if (action === 'up' && values.build) {
  await run('pnpm', ['build:relay'], 540_000);
  if (config.runtime === 'workers') await run('pnpm', ['--filter', '@borgee/agent-remote-cloudflare', 'run', 'build'], 120_000);
}
const args = ['compose', '--project-name', config.projectName, '--file', join(root, 'compose.yaml'), '--env-file', envFile, '--profile', config.runtime,
  ...(action === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '120', ...(values.build ? ['--build'] : [])] : action === 'down' ? ['down'] : ['ps'])];
await run('docker', args, values.build ? 900_000 : 150_000);
if (action === 'up') {
  for (const url of [config.gatewayUrl + '/health', config.relayUrl + '/health']) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Service readiness failed at ${new URL(url).origin}.`);
  }
  console.log(`Gateway: ${config.gatewayUrl}/#agent-remote\nRemote Controller: ${config.relayUrl}/`);
}
