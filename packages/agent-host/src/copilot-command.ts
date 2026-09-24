import {CopilotAgentProvider} from '@orchardworks/agent-provider-copilot';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {resolveHostEnvironment} from './connection-config.js';
import {sanitizeNativeEnvironment} from './execution-policy.js';
import {copilotExecutable} from './copilot-executable.js';
import {runManagedStdioCommand} from './stdio-command.js';

/** Explicit native session IDs allow coordinated, generation-bound ownership transfer. */
export async function runCopilotCommand(args: string[], stateDir: string, environment: NodeJS.ProcessEnv): Promise<number> {
  const configured = await resolveHostEnvironment(stateDir, environment);
  const env: NodeJS.ProcessEnv = {...sanitizeNativeEnvironment(configured), ...(configured.AGENT_HOST_COPILOT_HOME ? {COPILOT_HOME: configured.AGENT_HOST_COPILOT_HOME} : {})};
  const executable = await copilotExecutable(configured.AGENT_HOST_COPILOT, env);
  const boundary = args.indexOf('--');
  const isTakeoverFlag = (arg: string, index: number) => arg === '--take-over' && (boundary < 0 || index < boundary);
  const takeover = args.some(isTakeoverFlag); args = args.filter((arg, index) => !isTakeoverFlag(arg, index));
  let nativeArgs = args;
  if (args[0] === 'resume') {
    const target = args[1];
    nativeArgs = target === '--last' ? ['--continue', ...args.slice(2)]
      : target && !target.startsWith('-') ? [`--resume=${target}`, ...args.slice(2)] : ['--resume', ...args.slice(1)];
  }
  const resume = nativeArgs.find(arg=>arg.startsWith('--resume='))?.slice('--resume='.length)
    ?? (nativeArgs.includes('--resume') ? nativeArgs[nativeArgs.indexOf('--resume')+1] : undefined);
  async function verifyReleased(): Promise<void> {
    if (!resume || resume.startsWith('-')) return;
    const probe = new CopilotAgentProvider({executable, env, requestTimeoutMs: 5000});
    try {await probe.assertSessionAvailable(resume);} finally {await probe.dispose();}
  }
  return runManagedStdioCommand({providerId:'copilot',executable,env,nativeArgs,resume,takeover,verifyReleased,
    profile:env.COPILOT_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(),'.copilot')});
}
