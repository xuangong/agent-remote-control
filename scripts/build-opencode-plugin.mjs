import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const { build } = createRequire(resolve(root, 'packages/agent-remote-lab/package.json'))('esbuild');
await build({ entryPoints: [resolve(root, 'packages/agent-provider-opencode/src/bridge-plugin.mjs')],
  outfile: resolve(root, 'packages/agent-provider-opencode/dist/bridge-plugin.mjs'), bundle: true,
  platform: 'node', format: 'esm', target: 'node22' });
