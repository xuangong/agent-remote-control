import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node src/test-utils/check-packed-consumer.mjs /absolute/path/to/package.tgz');
const fixtures = dirname(fileURLToPath(import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), 'codex-packed-types-'));
console.log(`External consumer: ${consumer}`);
await mkdir(join(consumer, 'src/test-utils'), { recursive: true });
await mkdir(join(consumer, 'examples'));
await copyFile(resolve(archive), join(consumer, 'client.tgz'));
for (const name of ['packed-consumer.ts', 'packed-consumer.mjs']) {
  await copyFile(join(fixtures, name), join(consumer, 'src/test-utils', name));
}
await copyFile(join(fixtures, '../../examples/notebook.mjs'), join(consumer, 'examples/notebook.mjs'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
  packageManager: 'pnpm@10.34.5',
  dependencies: { '@agent-remote-controller/codex-daemon-client': 'file:./client.tgz', ws: '8.21.1' },
  devDependencies: { typescript: '5.9.3', '@types/node': '24.13.3' },
}, null, 2));
await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    strict: true, skipLibCheck: false, noEmit: true,
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', types: ['node'],
  },
  files: ['src/test-utils/packed-consumer.ts'],
}, null, 2));

function run(command, args, timeout) {
  console.log(`COMMAND: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: consumer, stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], 120_000);
run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], 30_000);
run(process.execPath, ['--test', '--test-timeout=15000', 'src/test-utils/packed-consumer.mjs'], 30_000);
console.log('Packed TypeScript declarations and JavaScript Unix consumer passed.');
