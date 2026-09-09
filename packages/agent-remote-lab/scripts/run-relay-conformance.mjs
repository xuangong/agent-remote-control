import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const lab = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run',
  'src/server/session-directory.test.ts', 'src/server/standalone-conformance.test.ts', 'src/server/remote-host-broker.test.ts',
  '--testTimeout=20000', '--hookTimeout=30000',
], { cwd: lab, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
child.once('error', (error) => { clearTimeout(timer); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
