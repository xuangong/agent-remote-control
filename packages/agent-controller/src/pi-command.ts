import {spawn} from 'node:child_process';
import {resolveHostEnvironment} from './connection-config.js';
import {piEnvironment} from './pi.js';
import {piInvocation, resolvePiExecutable} from './providers.js';

/** Runs the native pi with the Host's configured executable and profile, in this terminal. */
export async function runPiCommand(args: string[], stateDir: string, environment: NodeJS.ProcessEnv): Promise<number> {
  const configured = await resolveHostEnvironment(stateDir, environment);
  const env = { ...process.env, ...piEnvironment(configured, configured.AGENT_HOST_PI_HOME) };
  const executable = resolvePiExecutable(configured.AGENT_HOST_PI, env);
  const invocation = piInvocation(executable, args);
  const child = spawn(invocation.command, invocation.args, { env, stdio: 'inherit' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const interrupt = () => { child.kill('SIGINT'); }, terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const result = await exited;
    return result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
