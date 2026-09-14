import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.env.AGENT_REMOTE_WORKER_DIR ?? '/app/worker');
const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; };
const origin = required('AGENT_REMOTE_RELAY_URL');
const issuer = required('AGENT_REMOTE_ISSUER');
const secret = required('AGENT_REMOTE_SIGNING_SECRET');
const port = Number(required('AGENT_REMOTE_PORT'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local Relay port.');
if (Buffer.byteLength(secret) < 32) throw new Error('The signing secret must contain at least 32 bytes.');
await writeFile(resolve(directory, '.dev.vars'), `AGENT_REMOTE_SIGNING_SECRET=${JSON.stringify(secret)}\n`, { mode: 0o600 });
const config = {
  name: 'agent-remote-local', main: './worker.js', compatibility_date: '2026-06-01', compatibility_flags: ['nodejs_compat'],
  vars: { AGENT_REMOTE_RELAY_URL: origin, AGENT_REMOTE_ISSUER: issuer },
  durable_objects: { bindings: [{ name: 'RELAY', class_name: 'RelayObject' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['RelayObject'] }],
  assets: { directory: '../web', binding: 'ASSETS', run_worker_first: true },
};
await writeFile(resolve(directory, 'wrangler.local.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
const child = spawn('wrangler', ['dev', '--local', '--config', 'wrangler.local.json', '--ip', '0.0.0.0', '--port', String(port), '--persist-to', '/data/workers'], {
  cwd: directory, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('Could not start the local Workers runtime.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
