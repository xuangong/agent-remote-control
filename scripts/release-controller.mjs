// pnpm release:controller <version> --summary "<text>" [--gate-passed <log>] [--yes] [--dry-run]
// Cuts a Controller release from main (docs/controller-npm-release.md). The steps are scripts/lib/release-controller.mjs. Pushing,
// deploying and creating the GitHub release each need --yes or an interactive yes; --dry-run prints every command and runs none.
// Progress is kept in the git directory, so rerunning the same command skips finished steps and continues.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Refusal, runRelease } from './lib/release-controller.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { summary: { type: 'string' }, 'gate-passed': { type: 'string' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
const [version] = positionals;
const dry = Boolean(values['dry-run']);
const spawnIn = (argv, extra) => spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: argv[1] === 'fetch' ? 60_000 : undefined, ...extra });
const gitPath = spawnIn(['git', 'rev-parse', '--git-path', `arc-release-${version}.json`]).stdout.trim();
const statePath = resolve(root, gitPath);
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const manifest = join(root, 'packages/agent-controller/package.json');
const show = argv => `$ ${argv.map(part => /[\s"']/.test(part) ? JSON.stringify(part) : part).join(' ')}`;

const ctx = {
  dry,
  log: line => console.log(line),
  read: argv => { const { status, stdout } = spawnIn(argv); return { status, stdout: stdout ?? '' }; },
  exec(argv, extra) {
    console.log(show(argv));
    if (dry) return '';
    const result = spawnIn(argv, { stdio: 'inherit', ...extra });
    if (result.status !== 0) throw new Error(`${argv[0]} exited with ${result.status}; fix it and rerun to continue at this step.`);
    return '';
  },
  capture(argv) {
    console.log(show(argv));
    if (dry) return '';
    const result = spawnIn(argv);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0) throw new Error(`${argv[0]} exited with ${result.status}.`);
    return `${result.stdout}\n${result.stderr}`;
  },
  async confirm(what) {
    if (values.yes) return true;
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`   ${what}? [y/N] `);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  },
  state: { get: () => dry ? {} : load(), set(patch) { if (dry) return; mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify({ ...load(), ...patch }, null, 2)); } },
  exists: path => existsSync(resolve(root, path)),
  now: () => new Date(),
  readVersion: () => JSON.parse(readFileSync(manifest, 'utf8')).version,
  writeVersion: next => {
    console.log(`edit packages/agent-controller/package.json: version -> ${next}`);
    if (dry) return;
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
  },
};
if (!version) { console.error('Usage: pnpm release:controller <version> --summary "<text>" [--gate-passed <log>] [--yes] [--dry-run]'); process.exit(1); }
try {
  await runRelease(ctx, { version, summary: values.summary, gatePassed: values['gate-passed'], dry });
} catch (error) {
  console.error(error instanceof Refusal ? error.message : error.stack ?? error);
  process.exit(1);
}
