import { spawn } from 'node:child_process';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { localRelayConfiguration, composeEnvironment } from './relay-local-config.mjs';

/** Real process/container lifecycle shared by the two-runtime browser contract. */
export async function gatewayRelayTestRuntime({ root, gateway, temporary, env, relayPort, gatewayPort, launch, ready }) {
  const runtime = process.env.AGENT_REMOTE_TEST_RUNTIME ?? 'node';
  if (!['node', 'workers'].includes(runtime)) throw new Error('AGENT_REMOTE_TEST_RUNTIME must be node or workers.');
  const docker = process.env.AGENT_REMOTE_TEST_DOCKER === '1';
  let relay;
  const relayReady = join(temporary, 'relay.json');
  const workerDirectory = join(temporary, 'worker');
  const processReady = async () => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (relay.startupError) throw relay.startupError;
      if (relay.exitCode !== null) throw new Error('Workers runtime exited before readiness.');
      try { if ((await fetch(env.AGENT_REMOTE_RELAY_URL + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Workers readiness exceeded 25 seconds.');
  };
  let compose;
  async function dockerCommand(args) {
    const child = spawn('docker', [...compose, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout.on('data', value => { output = (output + value).slice(-16_384); });
    child.stderr.on('data', value => { output = (output + value).slice(-16_384); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 150_000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error(`Docker fixture operation failed (${args[0]}): ${output}`);
  }
  const startRelay = async () => {
    if (runtime === 'node') {
      relay = launch(process.execPath, ['--import', 'tsx/esm', 'src/server/gateway.ts'], join(root, 'packages/agent-remote-lab'), {
        ...env, AGENT_REMOTE_PORT: String(relayPort), AGENT_REMOTE_READY_FILE: relayReady, AGENT_REMOTE_STATE_DIR: join(temporary, 'state'),
      });
      await ready(relayReady, relay);
    } else {
      relay = launch('pnpm', ['--filter', '@agent-remote-controller/agent-remote-cloudflare', 'exec', 'wrangler', 'dev', '--local', '--config', join(workerDirectory, 'wrangler.json'),
        '--ip', '127.0.0.1', '--port', String(relayPort), '--persist-to', join(temporary, 'workers-state')], root, { WRANGLER_SEND_METRICS: 'false' });
      await processReady();
    }
  };
  if (docker) {
    const config = localRelayConfiguration({ runtime, gatewayPort, relayPort, gatewayImage: process.env.AGENT_REMOTE_GATEWAY_IMAGE, secret: env.AGENT_REMOTE_SIGNING_SECRET,
      projectName: `arc-test-${runtime}-${process.pid}` });
    const envFile = join(temporary, '.env'); await writeFile(envFile, composeEnvironment(config), { mode: 0o600 });
    compose = ['compose', '--project-name', config.projectName, '--file', join(root, 'compose.yaml'), '--file', join(root, 'deploy/compose.test.yaml'),
      '--env-file', envFile, '--profile', runtime];
  } else if (runtime === 'workers') {
    await mkdir(workerDirectory);
    await writeFile(join(workerDirectory, '.dev.vars'), `AGENT_REMOTE_SIGNING_SECRET=${JSON.stringify(env.AGENT_REMOTE_SIGNING_SECRET)}\n`, { mode: 0o600 });
    await writeFile(join(workerDirectory, 'wrangler.json'), JSON.stringify({
      name: 'agent-remote-test', main: join(root, 'dist/cloudflare/worker.js'), compatibility_date: '2026-06-01', compatibility_flags: ['nodejs_compat'],
      vars: { AGENT_REMOTE_RELAY_URL: env.AGENT_REMOTE_RELAY_URL, AGENT_REMOTE_ISSUER: env.AGENT_REMOTE_ISSUER },
      durable_objects: { bindings: [{ name: 'RELAY', class_name: 'RelayObject' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['RelayObject'] }],
      assets: { directory: join(root, 'dist/relay/web'), binding: 'ASSETS', run_worker_first: true },
    }));
  }
  return {
    runtime, docker,
    async start() {
      if (docker) return dockerCommand(['up', '-d', '--build', '--wait', '--wait-timeout', '90']);
      const file = join(temporary, 'gateway.json');
      const issuer = launch('bun', ['packages/gateway/tests/fixtures/agent-remote-gateway.ts'], join(gateway, 'vnext'), { ...env, PORT: String(gatewayPort), AGENT_REMOTE_READY_FILE: file });
      await ready(file, issuer);
      await startRelay();
    },
    async restart({ crash = false } = {}) {
      if (docker) {
        if (crash) {
          await dockerCommand(['kill', '--signal', 'SIGKILL', `relay-${runtime}`]);
          await dockerCommand(['rm', '--force', `relay-${runtime}`]);
        } else await dockerCommand(['restart', `relay-${runtime}`]);
        await dockerCommand(['up', '-d', '--wait', '--wait-timeout', '60']);
      } else {
        const exited = once(relay, 'exit'); process.kill(-relay.pid, crash ? 'SIGKILL' : 'SIGTERM');
        await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Relay stop exceeded 10 seconds.')), 10_000); timer.unref(); })]);
        if (runtime === 'workers') {
          const deadline = Date.now() + 5000;
          while (true) {
            try { await fetch(env.AGENT_REMOTE_RELAY_URL + '/health', { signal: AbortSignal.timeout(500) }); }
            catch { break; }
            if (Date.now() >= deadline) throw new Error('Previous Workers listener did not stop.');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        await rm(relayReady, { force: true });
        await startRelay();
      }
    },
    async close() {
      if (docker) await dockerCommand(['down', '--volumes', '--remove-orphans']);
    },
  };
}
