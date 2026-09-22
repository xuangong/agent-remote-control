import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageManager } from './lib/package-manager.mjs';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out-dir')) throw new Error('Usage: node scripts/build-agent-host.mjs [--out-dir PATH]');
const output = resolve(args[1] ?? join(root, 'dist/agent-remote-controller'));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const manifest = await readJson(join(root, 'packages/agent-host/package.json'));
const sdkDependencies = {};
for (const provider of ['claude', 'copilot']) {
  const { dependencies } = await readJson(join(root, `packages/agent-provider-${provider}/package.json`));
  for (const [name, version] of Object.entries(dependencies)) {
    if (!version.startsWith('workspace:')) sdkDependencies[name] = version;
  }
}
console.log('Building Agent Host and its workspace dependencies...');
await exec(...packageManager('pnpm', ['--filter', '@orchardworks/agent-remote-controller...', 'run', 'build']), { cwd: root, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
const require = createRequire(join(root, 'packages/agent-remote-lab/package.json'));
const { build } = require('esbuild');
const stage = await mkdtemp(join(tmpdir(), 'agent-host-package-'));
try {
  await build({
    entryPoints: { cli: join(root, 'packages/agent-host/src/cli.ts'), 'catalog-worker': join(root, 'packages/agent-provider-claude/src/catalog-worker.ts') },
    outdir: join(stage, 'dist'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: [...Object.keys(sdkDependencies), 'bufferutil', 'utf-8-validate'],
    banner: { js: 'import { createRequire as agentHostCreateRequire } from "node:module"; const require = agentHostCreateRequire(import.meta.url);' },
  });
  await chmod(join(stage, 'dist/cli.js'), 0o755);
  await cp(join(root, 'scripts/controller-launcher.mjs'), join(stage, 'dist/launcher.js'));
  await chmod(join(stage, 'dist/launcher.js'), 0o755);
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version,
    repository: { type: 'git', url: 'git+https://github.com/xuangong/agent-remote-control.git', directory: 'packages/agent-host' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
    description: 'Agent Remote Controller CLI: connect local Codex, Claude Code and Copilot to a Relay.',
    type: 'module', bin: { 'agent-remote-controller': 'dist/launcher.js' }, engines: { node: '>=22' }, os: ['darwin', 'linux', 'win32'],
    files: ['dist', 'README.md', 'licenses', 'NOTICE', 'build-info.json'],
    dependencies: sdkDependencies,
  }, null, 2) + '\n');
  const { stdout: revision } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const { stdout: changes } = await exec('git', ['status', '--porcelain'], { cwd: root });
  await writeFile(join(stage, 'build-info.json'), JSON.stringify({ version: manifest.version, revision: revision.trim(), dirty: changes.length > 0,
    builtAt: new Date().toISOString(), dependencies: sdkDependencies }, null, 2) + '\n');
  await cp(join(root, 'packages/agent-host/README.md'), join(stage, 'README.md'));
  await cp(join(root, 'NOTICE.md'), join(stage, 'NOTICE'));
  await mkdir(join(stage, 'licenses/codex'), { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) await cp(join(root, 'packages/agent-provider-codex', name), join(stage, 'licenses/codex', name));
  await mkdir(output, { recursive: true });
  const { stdout } = await exec(...packageManager('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', output]), { cwd: stage, timeout: 60000 });
  const [{ filename }] = JSON.parse(stdout);
  console.log(`Agent Host package: ${join(output, filename)}`);
  console.log(`Install: npm install -g ${join(output, filename)} --registry=https://mirrors.cloud.tencent.com/npm/`);
} finally { await rm(stage, { recursive: true, force: true }); }
