import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const mode = process.argv[2] ?? 'local';
if (!['local', 'recorded', 'codex-fixture', 'web'].includes(mode)) throw new Error('Usage: pnpm dev [local|recorded|codex-fixture|web]. Start native Codex separately with pnpm agent-remote-controller start.');
const host = '127.0.0.1';
const relayPort = Number(process.env.AGENT_REMOTE_PORT ?? 5910);
const webPort = Number(process.env.AGENT_REMOTE_WEB_PORT ?? 6175);
for (const port of mode === 'web' ? [webPort] : [relayPort, webPort]) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is already in use. Set AGENT_REMOTE_PORT and AGENT_REMOTE_WEB_PORT to free ports.`)));
    probe.listen(port, host, () => probe.close(resolve));
  });
}
const children = new Set();
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
function start(args) {
  const child = spawn('pnpm', ['--filter', '@agent-remote-controller/agent-remote-lab', 'exec', ...args], {
    stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, AGENT_REMOTE_WORKSPACE: process.env.AGENT_REMOTE_WORKSPACE ?? process.cwd(), AGENT_REMOTE_PORT: String(relayPort), AGENT_REMOTE_ORIGIN: `http://${host}:${webPort}`, VITE_AGENT_REMOTE_RELAY_TARGET: `http://${host}:${relayPort}`, ...(['local', 'codex', 'recorded'].includes(mode) ? { VITE_AGENT_REMOTE_FIXTURE_ENDPOINT: '/v1/lab/recorded' } : {}) },
  });
  children.add(child);
  child.once('error', (error) => { console.error(error); shutdown(1); });
  child.once('exit', (code) => { children.delete(child); shutdown(code ?? 1); });
}
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
if (mode !== 'web') start(['tsx', `src/server/${mode === 'codex-fixture' ? 'codex' : mode}.ts`]);
start(['vite', '--host', host, '--port', String(webPort), '--strictPort']);
console.log(`Agent Remote Control: http://${host}:${webPort}`);
if (mode === 'local') console.log('Native Codex runs in an independent managed Agent Host: generate a pairing key in the workbench, then run pnpm agent-remote-controller start. Use foreground only for attached debugging; it has no daemon pairing control.');
