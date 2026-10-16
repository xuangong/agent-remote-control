import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { controllerInvocation, devboxConfiguration } from './start.mjs';

try {
  const { origin } = devboxConfiguration();
  const [response, status] = await Promise.all([
    fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' }),
    promisify(execFile)(...controllerInvocation(process.env, ['status']), { timeout: 3000, maxBuffer: 65536 }),
  ]);
  await response.body?.cancel();
  process.exitCode = response.ok && /uplink: registered/.test(status.stdout) ? 0 : 1;
} catch { process.exitCode = 1; }
