// agent-remote-controller-dev: the Controller command line of a local development instance (pnpm local).
// pnpm local up copies this file to <root>/bin/ and installs the command, so it works whichever checkout installed it.
// It chooses the instance from the current directory and runs that instance's checkout's dev-command.mjs.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

// The root as pnpm local named it, which the installed commands pass on: instance paths keep the form the runner uses.
const root = process.env.ARC_LOCAL_ROOT ?? dirname(dirname(import.meta.filename));
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const inside = (path, directory) => path === directory || path.startsWith(directory + sep);
const real = path => { try { return realpathSync(path); } catch { return undefined; } };

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function instances() {
  let names = [];
  try { names = readdirSync(join(root, 'instances')); } catch { /* No instance yet. */ }
  return names.map(name => ({ directory: join(root, 'instances', name), record: read(join(root, 'instances', name, 'instance.json')) }))
    .filter(instance => instance.record?.source).map(instance => ({ ...instance, real: real(instance.directory) }));
}

/** The checkout of this project that contains a directory, if any. */
function checkoutOf(directory) {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, 'scripts', 'local', 'dev-command.mjs')) && existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/**
 * A session of an instance names it (ARC_LOCAL_INSTANCE); otherwise the instance directory or checkout the current
 * directory is in decides, and outside every checkout the instance that pnpm local up started last.
 */
function chooseInstance() {
  const known = instances();
  const named = process.env.ARC_LOCAL_INSTANCE;
  if (named) return known.find(instance => instance.real === real(named)) ?? fail(`The local instance ${named} no longer exists.`);
  const cwd = realpathSync(process.cwd());
  const containing = known.find(instance => instance.real && inside(cwd, instance.real));
  if (containing) return containing;
  const checkouts = known.filter(instance => inside(cwd, instance.record.source)).sort((a, b) => b.record.source.length - a.record.source.length);
  if (checkouts.length) return checkouts[0];
  const checkout = checkoutOf(cwd);
  if (checkout) fail(`The checkout ${checkout} has no local instance. Run pnpm local up there.`);
  const last = read(join(root, 'default.json'))?.directory;
  return known.find(instance => last && instance.real === real(last)) ?? fail('There is no local instance. Run pnpm local up in a checkout of agent-remote-control.');
}

const instance = chooseInstance();
const command = join(instance.record.source, 'scripts', 'local', 'dev-command.mjs');
if (!existsSync(command)) fail(`The checkout ${instance.record.source} of the local instance ${instance.directory} is gone. Remove the instance as docs/local-development.md describes.`);
const child = spawn(process.execPath, [command, instance.directory, ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => fail(`Could not run ${command}: ${error.message}`));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
