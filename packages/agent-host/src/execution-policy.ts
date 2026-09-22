import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRuntimeInfo, AgentSession } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory } from './host.js';

/** Trusted local admission policy. A cwd check is not a filesystem sandbox. */
export interface HostExecutionPolicy {
  readonly allowedWorkspaceRoots: readonly string[];
  readonly defaultWorkspace: string;
  readonly lockPermissions: boolean;
}
export async function createHostExecutionPolicy(env: NodeJS.ProcessEnv): Promise<HostExecutionPolicy | undefined> {
  if (env.AGENT_HOST_TRUSTED_FULL_CONTROL === '1') return undefined;
  const defaultWorkspace = await realpath(env.AGENT_HOST_WORKSPACE ?? env.AGENT_REMOTE_WORKSPACE ?? process.cwd());
  let roots: unknown = [defaultWorkspace];
  if (env.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS !== undefined) {
    try { roots = JSON.parse(env.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS); } catch { throw new Error('AGENT_HOST_ALLOWED_WORKSPACE_ROOTS must be a JSON array of workspace paths.'); }
  }
  if (!Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Allowed workspace roots must be a nonempty array of absolute paths.');
  }
  const allowedWorkspaceRoots = await Promise.all((roots as string[]).map(async root => {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Allowed workspace root must be a directory.');
    return canonical;
  }));
  const policy = { defaultWorkspace, allowedWorkspaceRoots, lockPermissions: true };
  await allowedWorkspace(policy, defaultWorkspace);
  return policy;
}
export class HostExecutionPolicyError extends Error {}
export async function allowedWorkspace(policy: HostExecutionPolicy, cwd: string | undefined): Promise<string> {
  if (!cwd) throw new HostExecutionPolicyError('Native session workspace is unavailable under the local Host policy.');
  let canonical: string;
  try {
    canonical = await realpath(resolve(cwd));
    if (!(await stat(canonical)).isDirectory()) throw new Error();
  } catch { throw new HostExecutionPolicyError('Workspace must be an existing directory allowed by the local Host policy.'); }
  if (!policy.allowedWorkspaceRoots.some(root => {
    const child = relative(root, canonical);
    return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  })) throw new HostExecutionPolicyError('Workspace is outside the local Host allowed roots.');
  return canonical;
}

/** Undefined entries intentionally mask secrets when adapters merge process.env again. */
export function sanitizeNativeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const native = { ...process.env, ...env };
  for (const key of Object.keys(native)) {
    if (/^(?:AGENT_HOST_|AGENT_REMOTE_|GATEWAY_|RELAY_)/i.test(key)) native[key] = undefined;
  }
  return native;
}
function protectedInfo(info: AgentRuntimeInfo, policy: HostExecutionPolicy): AgentRuntimeInfo {
  return !policy.lockPermissions || !info.settings ? info : { ...info, settings: info.settings.map(setting =>
    setting.category === 'permissions' ? { ...setting, mutable: false, description: 'Locked by local Host execution policy.' } : setting) };
}
export function protectHostDirectory(directory: AgentHostDirectory, policy: HostExecutionPolicy): AgentHostDirectory {
  const checkSource = async (id: string) => {
    const workspace = directory.sessionWorkspace ? await directory.sessionWorkspace(id)
      : (await directory.list()).find(entry => entry.nativeSessionId === id)?.workspace;
    await allowedWorkspace(policy, workspace);
  };
  directory.setSourceAccessCheck?.(checkSource);
  const sessions = new WeakMap<AgentSession, AgentSession>();
  async function protect(session: AgentSession): Promise<AgentSession> {
    try { await allowedWorkspace(policy, (await session.runtimeInfo()).cwd); }
    catch (error) { await session.dispose().catch(() => undefined); throw error; }
    const existing = sessions.get(session);
    if (existing) return existing;
    const wrapper = new Proxy(session, { get(target, key) {
      if (key === 'runtimeInfo') return async () => protectedInfo(await target.runtimeInfo(), policy);
      if (key === 'observe') return async function* () {
        for await (const item of target.observe()) yield item.type === 'observation' && item.event.type === 'runtime_updated'
          ? { ...item, event: { ...item.event, runtimeInfo: protectedInfo(item.event.runtimeInfo, policy) } } : item;
      };
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== 'function') return value;
      if (['sendMessage', 'steer', 'setPlanning', 'setSessionSetting', 'executeCommand', 'respondToInteraction', 'readResource'].includes(String(key))) {
        return async (...args: unknown[]) => {
          const info = await target.runtimeInfo();
          await allowedWorkspace(policy, info.cwd);
          if (key === 'setSessionSetting' && policy.lockPermissions && !info.settings?.some(setting => setting.id === args[0] && setting.category === 'model')) {
            throw new HostExecutionPolicyError('Native permission settings are locked by local Host policy.');
          }
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    } });
    sessions.set(session, wrapper);
    return wrapper;
  }
  return {
    providerId: directory.providerId,
    supportsSourceReferences: directory.supportsSourceReferences,
    reconcileIdleSession: directory.reconcileIdleSession?.bind(directory),
    canReleaseSession: directory.canReleaseSession?.bind(directory),
    sessionReleased: directory.sessionReleased?.bind(directory),
    async list() {
      const entries = await directory.list();
      return (await Promise.all(entries.map(async entry => {
        try { await allowedWorkspace(policy, entry.workspace); return entry; } catch { return undefined; }
      }))).filter((entry): entry is typeof entries[number] => entry !== undefined);
    },
    async workspaces() {
      return (await Promise.all((await directory.workspaces()).map(async workspace => {
        try { return { ...workspace, path: await allowedWorkspace(policy, workspace.path) }; } catch { return undefined; }
      }))).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
    ...(directory.models ? { models: directory.models.bind(directory) } : {}),
    async create(input) {
      const selected = input.workspaceId === undefined ? undefined : (await directory.workspaces()).find(workspace => workspace.id === input.workspaceId);
      if (input.workspaceId !== undefined && !selected) throw new HostExecutionPolicyError('Unknown local Host workspace.');
      const cwd = await allowedWorkspace(policy, input.cwd ?? selected?.path ?? policy.defaultWorkspace);
      if (input.sourceNativeSessionId) await checkSource(input.sourceNativeSessionId);
      return directory.create({ ...input, cwd });
    },
    async open(nativeSessionId) {
      const summary = (await directory.list()).find(entry => entry.nativeSessionId === nativeSessionId);
      await allowedWorkspace(policy, summary?.workspace);
      return protect(await directory.open(nativeSessionId));
    },
    ...(directory.openChild ? { async openChild(parent: string, child: string) { return protect(await directory.openChild!(parent, child)); } } : {}),
    close: directory.close.bind(directory),
  };
}
