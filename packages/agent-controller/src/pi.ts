import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {mkdir, realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sanitizeNativeEnvironment} from './execution-policy.js';
import {PiAgentProvider, piInvocation, piVersionIssue, resolvePiExecutable, parsePiVersion} from './providers.js';
import {createPiSessionDirectory} from './pi-directory.js';
import type {AgentHostProviderRegistration, AgentHostWorkspace} from './host.js';
import {SessionReferenceStore} from './session-reference.js';
import {SessionPermissionModeStore} from './permission-mode-store.js';
import {atomicWriteFile} from '@orchardworks/agent-platform';

const isPermissionMode = (mode: unknown): mode is 'ask' | 'allow' => mode === 'ask' || mode === 'allow';

export interface PiHostRegistrationOptions {
  executable?: string;
  /** The pi profile directory (PI_CODING_AGENT_DIR); defaults to ~/.pi/agent. */
  piHome?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  workspaces?: readonly AgentHostWorkspace[];
  referenceDirectory?: string;
  /** Where each session's last confirmed permission mode is kept; defaults to the Controller state for this profile. */
  permissionModeDirectory?: string;
}

/** The environment pi runs in: the Host's sanitised environment, the selected profile, and no update check or telemetry. */
export function piEnvironment(source: NodeJS.ProcessEnv, piHome?: string): NodeJS.ProcessEnv {
  return { ...sanitizeNativeEnvironment(source), ...(piHome ? { PI_CODING_AGENT_DIR: piHome } : {}), PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}

export async function createPiHostRegistration(options: PiHostRegistrationOptions = {}): Promise<AgentHostProviderRegistration> {
  const env = piEnvironment(options.env ?? {}, options.piHome);
  const executable = resolvePiExecutable(options.executable, { ...process.env, ...env });
  const invocation = piInvocation(executable, ['--version']);
  const { stdout, stderr } = await promisify(execFile)(invocation.command, invocation.args, { timeout: 30000, env: { ...process.env, ...env } });
  const output = `${stdout}\n${stderr}`;
  const issue = piVersionIssue(output);
  if (issue) throw new Error(issue.message);
  const profile = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.pi', 'agent');
  await mkdir(profile, { recursive: true });
  const scope = createHash('sha256').update(await realpath(profile)).digest('hex');
  const references = new SessionReferenceStore(options.referenceDirectory ?? join(homedir(), '.agent-remote-control', 'session-references', 'pi', scope), 'pi');
  // Each session reopens in the permission mode its owner last confirmed.
  const permissionModes = new SessionPermissionModeStore(options.permissionModeDirectory ?? join(homedir(), '.agent-remote-control', 'session-permissions', 'pi', scope), isPermissionMode, atomicWriteFile);
  const providerOptions = { executable, env, requestTimeoutMs: options.requestTimeoutMs, onDiagnostic: options.onDiagnostic, permissionModes };
  const provider = new PiAgentProvider(providerOptions);
  try {
    return { nativePermissionControl: true, nativeVersion: parsePiVersion(output), adapter: provider, directory: createPiSessionDirectory(provider, options.workspaces ?? [], references) };
  } catch (error) { await provider.dispose(); throw error; }
}
