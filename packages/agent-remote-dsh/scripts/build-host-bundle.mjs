import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'dist/host-bundle'));
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, '.package-'));
try {
  await build({
    entryPoints: [join(root, 'src/agent-remote.ts')], outfile: join(stage, 'lib/index.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['@deepseek-ai/*', 'node:*', 'bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: '@agent-remote-control/dsh-host', version: metadata.version, private: true, type: 'module',
    main: './lib/index.js', exports: { '.': './lib/index.js', './package.json': './package.json' },
    files: ['lib/index.js', 'cordis.patch.yml'], engines: { node: '>=22' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/schemastery': '^3.18.2',
      '@deepseek-ai/dsh-agent': '0.1.2-rc.1', '@deepseek-ai/dsh-session': '0.1.2-rc.1', '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
    },
  }, null, 2) + '\n');
  await writeFile(join(stage, 'cordis.patch.yml'), '- insert:\n    - id: agent-remote-control-host\n      name: "@agent-remote-control/dsh-host"\n      inject: [agents, agentDefaultModel, sessions, sessionController, sessionQuery, agentPresets, workspaceRegistry, userQuestions, approval, settings]\n');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: stage, encoding: 'utf8', timeout: 60_000 }));
  process.stdout.write(join(output, packed[0].filename) + '\n');
} finally { await rm(stage, { recursive: true, force: true }); }
