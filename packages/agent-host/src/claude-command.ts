import {join} from 'node:path';
import {homedir} from 'node:os';
import {resolveHostEnvironment} from './connection-config.js';
import {sanitizeNativeEnvironment} from './execution-policy.js';
import {resolveNativeExecutable} from './platform/executables/index.js';
import {runManagedStdioCommand} from './stdio-command.js';

export async function runClaudeCommand(args: string[], stateDir: string, environment: NodeJS.ProcessEnv): Promise<number> {
 const configured=await resolveHostEnvironment(stateDir,environment);
 const env: NodeJS.ProcessEnv={...sanitizeNativeEnvironment(configured),...(configured.AGENT_HOST_CLAUDE_HOME ? {CLAUDE_CONFIG_DIR:configured.AGENT_HOST_CLAUDE_HOME} : {})};
 const executable=resolveNativeExecutable(configured.AGENT_HOST_CLAUDE ?? 'claude','@anthropic-ai/claude-code/cli.js',env);
 const boundary=args.indexOf('--');
 const isTakeover=(arg:string,index:number)=>arg==='--take-over' && (boundary<0 || index<boundary);
 const takeover=args.some(isTakeover);args=args.filter((arg,index)=>!isTakeover(arg,index));
 const target=args[1];
 const nativeArgs=args[0]==='resume' ? target==='--last' ? ['--continue',...args.slice(2)] : ['--resume',...args.slice(1)] : args;
 const nativeBoundary=nativeArgs.indexOf('--');
 const controlArgs=nativeBoundary<0 ? nativeArgs : nativeArgs.slice(0,nativeBoundary);
 const resume=controlArgs.find(arg=>arg.startsWith('--resume='))?.slice('--resume='.length)
  ?? (controlArgs.includes('--resume') ? controlArgs[controlArgs.indexOf('--resume')+1] : undefined);
 return runManagedStdioCommand({providerId:'claude',executable,env,nativeArgs,resume,takeover,
  profile:env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? env.USERPROFILE ?? homedir(),'.claude'),
  // Claude has no public session-lock probe. Managed owners confirm actual exit before transferring the lease.
  verifyReleased:async()=>{}});
}
