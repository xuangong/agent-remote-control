import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function containerEnvironment(input) {
  const env = { ...input };
  const state = env.AGENT_HOST_STATE_DIR || '/data/host';
  let saved;
  try { saved = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read saved Host connection. Restore the state volume before starting.'); }
  if (saved) {
    if (typeof saved.serverUrl !== 'string' || typeof saved.remoteKey !== 'string' || !saved.remoteKey) throw new Error('Saved Host connection is invalid.');
    if (env.AGENT_HOST_SERVER && new URL(env.AGENT_HOST_SERVER).origin !== new URL(saved.serverUrl).origin) {
      throw new Error('This state volume belongs to another Relay. Use a separate volume for a different Relay.');
    }
    // A one-time invitation in Compose must not override the accepted device credential on restart.
    delete env.AGENT_HOST_SERVER;
    delete env.AGENT_HOST_REMOTE_KEY;
  } else if (env.AGENT_HOST_REMOTE_KEY_FILE) {
    if (env.AGENT_HOST_REMOTE_KEY) throw new Error('Configure either a pairing key file or a pairing key, not both.');
    env.AGENT_HOST_REMOTE_KEY = (await readFile(env.AGENT_HOST_REMOTE_KEY_FILE, 'utf8')).trim();
  }
  delete env.AGENT_HOST_REMOTE_KEY_FILE;
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (['start', '_serve', 'autostart'].includes(args[0])) {
      throw new Error('Containers must use foreground. The container supervisor owns startup; the release launcher owns Controller updates.');
    }
    const env = await containerEnvironment(process.env);
    const child = spawn('agent-remote-controller', args.length ? args : ['foreground'], { env, stdio: 'inherit' });
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));
    child.once('error', () => { process.stderr.write('Could not start Agent Remote Controller.\n'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
