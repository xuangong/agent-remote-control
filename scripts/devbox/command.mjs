import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerBuildProvenance } from '../lib/build-provenance.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const environment = { ...process.env };
if (environment.DEVBOX_SOURCE_REVISION === undefined && environment.DEVBOX_SOURCE_DIRTY === undefined) {
  try {
    const source = await controllerBuildProvenance(root, {});
    environment.DEVBOX_SOURCE_REVISION = source.revision;
    environment.DEVBOX_SOURCE_DIRTY = String(source.dirty);
  } catch { process.stderr.write('Devbox source has no Git identity; using the documented source-snapshot revision.\n'); }
}
const args = process.argv.slice(2);
if (!args.length) args.push('up', '--build', '-d');
const child = spawn('docker', ['compose', '--project-name', environment.DEVBOX_PROJECT ?? 'arc-devbox',
  '--file', resolve(root, 'deploy/devbox/compose.yaml'), ...args], { cwd: root, env: environment, stdio: 'inherit' });
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.exitCode = code ?? 1; });
