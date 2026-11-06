import { basename, delimiter, sep } from 'node:path';

const passed = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);

/**
 * The development Controller starts from an explicit environment: grants, nested-session markers and
 * trusted full control from the launching shell never reach it, and package-manager shims leave PATH.
 * Native profile variables are not set, so the user's default native profiles are shared.
 */
export function controllerEnvironment(parent, instance) {
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (passed.has(key) || key.startsWith('LC_'))) environment[key] = value;
  }
  environment.PATH = (parent.PATH ?? '').split(delimiter)
    .filter(entry => entry && !entry.split(sep).includes('node_modules')).join(delimiter);
  return {
    ...environment,
    AGENT_HOST_STATE_DIR: instance.controller,
    AGENT_HOST_WORKSPACE: instance.workspace,
    AGENT_HOST_ALLOWED_WORKSPACE_ROOTS: JSON.stringify([instance.workspace]),
    AGENT_HOST_NAME: `Dev · ${basename(instance.record.source)}`,
    // Reuse the Codex daemon and OpenCode server of the user's Controller without managing their lifecycle.
    AGENT_HOST_CODEX_AUTO_START: '0',
    AGENT_HOST_OPENCODE_AUTO_START: '0',
  };
}
