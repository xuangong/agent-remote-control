import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await rm(`${root}/dist/web`, { recursive: true, force: true });
await mkdir(`${root}/dist/web`, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['web/index.tsx'], outdir: 'dist/web',
  bundle: true, format: 'esm', splitting: true, platform: 'browser', target: 'es2022',
  jsx: 'automatic', minify: true, sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  loader: { '.woff2': 'file', '.md': 'text' }, assetNames: 'assets/[name]-[hash]',
});
await copyFile(`${root}/web/index.html`, `${root}/dist/web/index.html`);
