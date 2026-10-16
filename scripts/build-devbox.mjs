import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'packages/agent-remote-lab/package.json'));
const { build } = require('esbuild');
const output = join(root, 'dist/devbox');
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, 'packages/agent-remote-lab/src/server/devbox.ts')],
  outfile: join(output, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as devboxCreateRequire } from "node:module"; const require = devboxCreateRequire(import.meta.url);' },
});
console.log('Built the Devbox server in dist/devbox/server.mjs.');
