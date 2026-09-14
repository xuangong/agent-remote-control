import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: packageRoot, entryPoints: ['src/worker.ts'], outfile: '../../dist/cloudflare/worker.js',
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', sourcemap: true,
  conditions: ['workerd', 'worker', 'import'], external: ['node:*', 'cloudflare:*'],
});
