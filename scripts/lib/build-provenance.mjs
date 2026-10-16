import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Source archives carry explicit provenance; ordinary builds read their checkout. */
export async function controllerBuildProvenance(directory, environment = process.env) {
  const revision = environment.AGENT_HOST_BUILD_REVISION;
  const dirty = environment.AGENT_HOST_BUILD_DIRTY;
  if (revision !== undefined || dirty !== undefined) {
    if (revision === undefined || dirty === undefined) throw new Error('Explicit Controller source identity requires both revision and dirty settings.');
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Controller build revision must contain 40 lowercase hexadecimal characters.');
    if (dirty !== 'true' && dirty !== 'false') throw new Error('Controller build dirty must be true or false.');
    return { revision, dirty: dirty === 'true' };
  }
  const exec = promisify(execFile);
  const options = { cwd: directory, timeout: 10000, maxBuffer: 1024 * 1024 };
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], options);
  const { stdout: changes } = await exec('git', ['status', '--porcelain'], options);
  return { revision: head.trim(), dirty: changes.length > 0 };
}
