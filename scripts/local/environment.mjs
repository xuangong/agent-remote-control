import { basename, delimiter, sep } from 'node:path';

const allowedParentVariables = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The development Controller starts from an explicit environment: grants, nested-session markers and
 * trusted full control from the launching shell never reach it, and package-manager shims leave PATH.
 * Native profile variables are not set, so the user's default native profiles are shared.
 */
export function controllerEnvironment(parent, instance) {
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (allowedParentVariables.has(key) || key.startsWith('LC_'))) environment[key] = value;
  }
  const path = (parent.PATH ?? '').split(delimiter)
    .filter(entry => entry && !entry.split(sep).includes('node_modules')).join(delimiter);
  return {
    ...environment,
    PATH: path || systemPath,
    AGENT_HOST_STATE_DIR: instance.controller,
    AGENT_HOST_WORKSPACE: instance.workspace,
    AGENT_HOST_ALLOWED_WORKSPACE_ROOTS: JSON.stringify([instance.workspace]),
    AGENT_HOST_NAME: `Dev · ${basename(instance.record.source)}`,
    // Saved connection settings are merged under the environment, so only an explicit value overrides one
    // persisted in the instance state; leaving it absent would let a saved '1' lift the workspace policy.
    AGENT_HOST_TRUSTED_FULL_CONTROL: '0',
    // The instance never starts, restarts or updates the Codex daemon or OpenCode server; they belong to the user's Controller.
    AGENT_HOST_CODEX_AUTO_START: '0',
    AGENT_HOST_OPENCODE_AUTO_START: '0',
    // In the instance's sessions, agent-remote-controller is this instance's development command (bin/ holds it),
    // and the skill they read stays the one installed for the user: nothing is written to the Codex home.
    AGENT_HOST_SESSION_BIN: instance.bin,
    AGENT_HOST_CODEX_USER_SKILLS: '0',
  };
}
