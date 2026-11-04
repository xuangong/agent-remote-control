import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSessionHostAccess } from '@orchardworks/agent-provider-sdk';

/** The permission profile a Host-imposed sandbox runs under when its commands must reach Host sockets. */
export const HOST_ACCESS_PROFILE = 'agent-remote';
/** The first Codex release whose managed network proxy was verified to allow exactly the listed sockets. */
const SOCKET_PROFILE_VERSION = [0, 166, 0] as const;

type Access = 'read_only' | undefined;

/** Read-only sessions take the read-only sandbox; restricted Hosts otherwise confine writes to the workspace. */
export function sandboxParams(access: Access, restrictedNative: boolean) {
  if (access === 'read_only') return { sandbox: 'read-only', approvalPolicy: 'never' } as const;
  return restrictedNative ? { sandbox: 'workspace-write', approvalPolicy: 'never' } as const : {};
}

/**
 * The thread parameters and configuration overrides that give a thread's shell commands the Host's access.
 *
 * Variables reach commands through shell_environment_policy.set, which Codex applies after its default exclusions.
 * With network disabled, Seatbelt denies every Unix socket. The only per-path allowance a thread can carry is the
 * managed network proxy's: a profile with network enabled, whose direct connections stay denied and whose proxy allows
 * no domain. Without the network_proxy feature the same profile would open the internet, so it is used only where the
 * Host imposes the sandbox, on versions and platforms verified to honor it. The sandbox parameter would override the
 * profile, so the profile replaces it. A sandbox from the user's own configuration is left unchanged.
 */
export function codexHostAccess(hostAccess: AgentSessionHostAccess | undefined, access: Access, restrictedNative: boolean, initialization: unknown) {
  const params = sandboxParams(access, restrictedNative);
  if (!hostAccess) return { params, config: {} };
  const config: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(hostAccess.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid Host environment variable name.');
    config[`shell_environment_policy.set.${name}`] = value;
  }
  if (!('sandbox' in params) || !hostAccess.unixSockets.length || !socketProfileSupported(initialization)) return { params, config };
  config['features.network_proxy'] = true;
  config[`permissions.${HOST_ACCESS_PROFILE}`] = { extends: params.sandbox === 'read-only' ? ':read-only' : ':workspace',
    network: { enabled: true, unix_sockets: Object.fromEntries(hostAccess.unixSockets.map(path => [path, 'allow'])) } };
  config.default_permissions = HOST_ACCESS_PROFILE;
  return { params: { approvalPolicy: params.approvalPolicy }, config };
}

function socketProfileSupported(initialization: unknown): boolean {
  if (!initialization || typeof initialization !== 'object') return false;
  const { userAgent, platformOs } = initialization as { userAgent?: unknown; platformOs?: unknown };
  const match = typeof userAgent === 'string' ? /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent) : null;
  if (platformOs !== 'macos' || !match) return false;
  const version = match.slice(1, 4).map(Number);
  for (const [index, minimum] of SOCKET_PROFILE_VERSION.entries()) {
    if (version[index] !== minimum) return version[index]! > minimum;
  }
  return true;
}

/**
 * Codex has no skills per thread, so Host skills go to the Codex home, where the user's own sessions see them too.
 * Each skill's SKILL.md is written only when it differs, through a temporary file. A missing Codex home is left alone.
 */
export async function installCodexSkills(skills: string, codexHome: string): Promise<void> {
  try { if (!(await stat(codexHome)).isDirectory()) return; }
  catch { return; }
  for (const entry of await readdir(join(skills, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contents = await readFile(join(skills, 'skills', entry.name, 'SKILL.md'), 'utf8');
    const target = join(codexHome, 'skills', entry.name, 'SKILL.md');
    if (await readFile(target, 'utf8').catch(() => undefined) === contents) continue;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o644 });
    await rename(temporary, target);
  }
}
