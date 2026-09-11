import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const nativeRepo = process.env.DSH_NATIVE_TEST_REPO;

/** Opt-in source characterization: native AgentLoop and persistence, with scripted model responses. */
it.skipIf(!nativeRepo)('validates native child cancellation, parked input, and parent-address authority', async () => {
  const native = await realpath(resolve(nativeRepo!));
  const root = await mkdtemp(join(tmpdir(), 'agent-remote-dsh-native-cancel-'));
  try {
    await mkdir(join(root, 'home'));
    await mkdir(join(root, 'tmp'));
    await symlink(join(native, 'node_modules'), join(root, 'node_modules'), 'dir');
    const original = join(native, 'packages/subagent/subagent/tests/continuation.spec.ts');
    // Reuse upstream controlled fixtures and interruption cases without writing into its checkout.
    const suite = (await readFile(original, 'utf8')).replace(/(from ['"])(\.[^'"]+)(['"])/g,
      (_match, prefix, location, suffix) => `${prefix}${resolve(dirname(original), location)}${suffix}`);
    const adapterPath = fileURLToPath(new URL('./children.ts', import.meta.url));
    const probe = await readFile(new URL('./test-utils/native-child-cancel-probe.txt', import.meta.url), 'utf8');
    await writeFile(join(root, 'continuation.spec.ts'), `${suite}\n${probe.replace('__CHILD_ADAPTER_PATH__', JSON.stringify(adapterPath))}`);
    const ts = createRequire(join(native, 'package.json'))('typescript');
    const paths = ts.readConfigFile(join(native, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths as Record<string, string[]>;
    const alias = Object.entries(paths).filter(([name]) => !name.includes('*')).sort(([a], [b]) => b.length - a.length)
      .map(([find, locations]) => ({ find, replacement: resolve(native, locations[0]!) }));
    const config = `
import { defineConfig } from ${JSON.stringify(await realpath(join(native, 'node_modules/vitest/dist/config.js')))};
import { standardDecoratorPlugin, vitestExecArgv } from ${JSON.stringify(join(native, 'vitest.shared.ts'))};
const native = ${JSON.stringify(native)};
export default defineConfig({
  root: ${JSON.stringify(root)}, cacheDir: ${JSON.stringify(join(root, 'cache'))},
  resolve: { alias: ${JSON.stringify(alias)} }, plugins: [standardDecoratorPlugin()],
  test: { include: ['*.spec.ts'], setupFiles: [native + '/scripts/test-invariants.ts'],
    pool: 'forks', execArgv: vitestExecArgv, testTimeout: 10000, hookTimeout: 30000 }
});
`;
    await writeFile(join(root, 'vitest.config.mjs'), config);
    const env = { ...process.env, DSH_HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') };
    const revision = (await run('git', ['-C', native, 'rev-parse', 'HEAD'], root, env, 5000)).trim();
    const output = await run(process.execPath, [join(native, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', join(root, 'vitest.config.mjs'), '--configLoader=runner', '-t', 'SubagentRuntime.interrupt',
      '--reporter=json', '--outputFile', join(root, 'result.json')], root, env, 45000);
    const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
    expect(result.success, output).toBe(true);
    expect(result.numFailedTests, output).toBe(0);
    expect(result.numPassedTests, output).toBeGreaterThanOrEqual(9);
    process.stdout.write(`[dsh-native-child-cancel] source=${revision} passed=${result.numPassedTests} skipped=${result.numPendingTests}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const stop = () => {
      try { if (child.pid) { if (grouped) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } } catch { /* Already exited. */ }
    };
    const deadline = setTimeout(() => { stop(); reject(new Error(`Native child probe timed out after ${timeout}ms.\n${output}`)); }, timeout);
    child.stdout.on('data', data => { output = (output + data).slice(-100000); });
    child.stderr.on('data', data => { output = (output + data).slice(-100000); });
    child.once('error', error => { clearTimeout(deadline); stop(); reject(error); });
    child.once('close', code => {
      clearTimeout(deadline); stop();
      if (code === 0) resolveOutput(output);
      else reject(new Error(`Native child probe exited with ${code}.\n${output}`));
    });
  });
}
