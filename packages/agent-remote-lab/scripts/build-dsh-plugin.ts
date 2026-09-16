import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCompatibilityManifest, requireProviderCompatibility } from '../src/server/compatibility.js';

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(labRoot, '..');
const packageName = '@agent-remote-controller/agent-remote-lab-dsh';

export interface DshPluginBuildOptions {
  outputRoot?: string;
  manifestPath?: string;
}

export async function buildDshPlugin(options: DshPluginBuildOptions = {}): Promise<string> {
  const compatibility = loadCompatibilityManifest(options.manifestPath ?? join(labRoot, 'compatibility.json'));
  const outputRoot = resolve(options.outputRoot ?? join(labRoot, 'dist/dsh-plugin'));
  await mkdir(outputRoot, { recursive: true });
  const stage = await mkdtemp(join(outputRoot, '.package-'));
  try {
    const alias = Object.fromEntries([
      'agent-provider-sdk', 'agent-provider-dsh', 'agent-provider-codex',
      'agent-remote-protocol', 'agent-remote-relay',
    ].map((name) => [`@agent-remote-controller/${name}`, join(packagesRoot, name, 'src/index.ts')]));
    alias['@agent-remote-controller/dsh'] = join(packagesRoot, 'agent-remote-dsh/src/index.ts');
    const bundle = await build({
      entryPoints: [join(labRoot, 'src/server/installed-dsh-plugin.ts')],
      outfile: join(stage, 'lib/index.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias,
      external: ['@deepseek-ai/*', 'node:*', 'bufferutil', 'utf-8-validate'],
      banner: { js: "import { createRequire as __nodeCreateRequire } from 'node:module';\nconst require = __nodeCreateRequire(import.meta.url);" },
      metafile: true,
      logLevel: 'silent',
    });
    const nativeVersion = requireProviderCompatibility(compatibility, 'dsh').native.version;
    const peers = Object.fromEntries(Object.values(bundle.metafile.outputs)
      .flatMap(({ imports }) => imports)
      .filter(({ external, path }) => external && path.startsWith('@deepseek-ai/'))
      .map(({ path }) => {
        const name = path.split('/').slice(0, 2).join('/');
        if (!name.startsWith('@deepseek-ai/dsh-')) throw new Error(`No native version authority is declared for ${name}.`);
        return [name, nativeVersion];
      }));
    const manifest = {
      name: packageName,
      version: '0.1.0',
      private: true,
      type: 'module',
      description: 'Local Agent Remote Lab adapter for the DSH Web profile.',
      main: './lib/index.js',
      exports: { '.': './lib/index.js', './package.json': './package.json' },
      files: ['lib/index.js', 'cordis.patch.yml', 'compatibility.json'],
      engines: { node: '>=22.13.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: peers,
    };
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(stage, 'cordis.patch.yml'), `- insert:\n    - id: borgee-agent-remote-lab\n      name: '${packageName}'\n      inject: [sessionController, sessionQuery, workspaceRegistry, agentPresets, userQuestions, approval]\n`);
    const scope = ['cordis.patch.yml', 'lib/index.js', 'package.json'];
    const hash = createHash('sha256');
    for (const path of scope) {
      hash.update(path);
      hash.update('\0');
      hash.update(await readFile(join(stage, path)));
      hash.update('\0');
    }
    compatibility.borgee.implementation = { algorithm: 'sha256', root: '.', scope, digest: `sha256:${hash.digest('hex')}` };
    await writeFile(join(stage, 'compatibility.json'), `${JSON.stringify(compatibility, null, 2)}\n`);
    loadCompatibilityManifest(join(stage, 'compatibility.json'));
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outputRoot], {
      cwd: stage, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ filename: string }>;
    if (packed.length !== 1 || !packed[0]?.filename) throw new Error('npm pack did not return one plugin archive.');
    return join(outputRoot, packed[0].filename);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await buildDshPlugin()}\n`);
}
