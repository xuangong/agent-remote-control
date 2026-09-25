import { spawn } from 'node:child_process';
import { resolveHostEnvironment } from './connection-config.js';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { nativeInvocation, resolveNativeExecutable } from './platform/executables/index.js';

/** Attach to the independently running server without taking ownership of its sessions. */
export async function runOpenCodeCommand(args: string[], stateDir: string, environment: NodeJS.ProcessEnv): Promise<number> {
  const configured = await resolveHostEnvironment(stateDir, environment);
  if (args[0] === 'callbacks') {
    if (args[1] !== 'setup' || args.length !== 3 || !args[2]) throw new Error('Use opencode callbacks setup <private-directory>.');
    const { setupOpenCodeCallbacks } = await import('@orchardworks/agent-provider-opencode');
    const paths = await setupOpenCodeCallbacks(args[2]);
    process.stdout.write(JSON.stringify({ ...paths, instruction: 'Start the independently managed native server with OPENCODE_CONFIG set to nativeConfigPath. Set AGENT_HOST_OPENCODE_CALLBACK_CONFIG to configPath for the Controller. Use the same loopback hostname and port for AGENT_HOST_OPENCODE_URL and opencode serve. Existing servers require an explicit operator restart to load the plugin.' }, null, 2) + '\n');
    return 0;
  }
  const env = sanitizeNativeEnvironment(configured);
  const executable = resolveNativeExecutable(configured.AGENT_HOST_OPENCODE ?? 'opencode', 'opencode-ai/bin/opencode', env);
  let nativeArgs = args;
  if (!args.length || args[0] === 'resume') {
    if (args.includes('--take-over')) throw new Error('OpenCode uses shared control; takeover is unavailable.');
    const target = args[1];
    if (args.length && (!target || target.startsWith('-') && target !== '--last')) throw new Error('Use opencode resume <session-id> or opencode resume --last.');
    const endpoint = configured.AGENT_HOST_OPENCODE_URL ?? 'http://127.0.0.1:4096';
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('OpenCode server URL must be an HTTP endpoint without credentials, query or fragment.');
    nativeArgs = ['attach', endpoint, ...(!args.length ? ['--dir', process.cwd()] : target === '--last' ? ['--continue', ...args.slice(2)] : ['--session', target!, ...args.slice(2)])];
    if (configured.AGENT_HOST_OPENCODE_USERNAME !== undefined) env.OPENCODE_SERVER_USERNAME = configured.AGENT_HOST_OPENCODE_USERNAME;
    if (configured.AGENT_HOST_OPENCODE_PASSWORD !== undefined) env.OPENCODE_SERVER_PASSWORD = configured.AGENT_HOST_OPENCODE_PASSWORD;
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(...nativeInvocation(executable, nativeArgs), { env, stdio: 'inherit' });
    const interrupt = () => { child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });
  });
}
