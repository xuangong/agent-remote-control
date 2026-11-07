// agent-remote-controller-dev for one instance of this checkout: node scripts/local/dev-command.mjs <instance directory> [args]
// The installed launcher (dev-launcher.mjs) chooses the instance and runs this file from the instance's checkout.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';
import { controllerCli, controllerCommand } from './controller.mjs';
import { instanceFiles, readJson, runState } from './instance.mjs';

const source = realpathSync(resolve(import.meta.dirname, '../..'));

async function buildInfo(instance) {
  const runtime = await readJson(instance.runtimeFile);
  // A session's sandbox may not let it inspect processes; the build is still known from the run file.
  const [state, checkout] = await Promise.all([runState(instance.directory, runtime).catch(() => 'unknown'),
    controllerBuildProvenance(source, {}).catch(() => undefined)]);
  return {
    instance: instance.record.name, directory: instance.directory, origin: instance.record.origin, source, state,
    build: runtime ? { revision: runtime.revision ?? null, dirty: runtime.dirty ?? null, startedAt: runtime.startedAt } : null,
    checkout: checkout ? { revision: checkout.revision, dirty: checkout.dirty } : null,
    controller: controllerCli(source), sessionCommands: instance.bin,
  };
}

const [directory, ...args] = process.argv.slice(2);
try {
  const instance = { ...instanceFiles(directory), record: await readJson(instanceFiles(directory).recordFile) };
  if (instance.record?.source !== source) throw new Error(`${directory} is not a local instance of ${source}.`);
  if (args[0] === '--build-info') process.stdout.write(JSON.stringify(await buildInfo(instance), null, 2) + '\n');
  else if (args[0] === 'update') throw new Error(`agent-remote-controller-dev runs the build of ${source}. Rebuild and restart it with pnpm local up there; your installed agent-remote-controller was not changed.`);
  else process.exitCode = await controllerCommand({ source, instance, args });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
