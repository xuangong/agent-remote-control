import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const build = spawn('pnpm', ['--filter', '@agent-remote-controller/agent-remote-lab...', 'run', 'build'], { cwd: root, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', resolve); });
if (code !== 0) process.exit(code ?? 1);
const require = createRequire(join(root, 'packages/agent-remote-lab/package.json'));
const { build: bundle } = require('esbuild');
const output = join(root, 'dist/relay');
await mkdir(output, { recursive: true });
await bundle({ entryPoints: [join(root, 'packages/agent-remote-lab/src/server/gateway.ts')], outfile: join(output, 'gateway.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as relayCreateRequire } from "node:module"; const require = relayCreateRequire(import.meta.url);' },
});
await rm(join(output, 'web'), { recursive: true, force: true });
await cp(join(root, 'packages/agent-remote-lab/dist'), join(output, 'web'), { recursive: true });
console.log('Built standalone Relay and Controller artifacts in dist/relay.');
