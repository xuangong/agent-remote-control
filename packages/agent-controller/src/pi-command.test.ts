import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runPiCommand } from './pi-command.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('runs the configured pi with the selected profile and the given arguments, and returns its exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-command-')); temporary.push(directory);
  const report = join(directory, 'report.json');
  const executable = join(directory, 'pi.mjs');
  await writeFile(executable, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.PI_CODING_AGENT_DIR })); process.exit(3);`, { mode: 0o700 });
  const code = await runPiCommand(['--session', 'abc'], join(directory, 'state'), { AGENT_HOST_PI: executable, AGENT_HOST_PI_HOME: join(directory, 'profile'), PATH: process.env.PATH });
  expect(code).toBe(3);
  expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({ args: ['--session', 'abc'], home: join(directory, 'profile') });
});
