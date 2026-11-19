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

const journalLimitNames = ['sessionBytes', 'hostBytes', 'liveOnlyItems'];

/**
 * The Relay's journal limits for a run that needs a quota to bite: `ARC_LOCAL_JOURNAL_LIMITS` is a JSON object of positive whole
 * numbers named `sessionBytes`, `hostBytes` or `liveOnlyItems`. Absent, the Relay keeps its production defaults. The limits mean
 * nothing without journals, so they are refused unless `ARC_LOCAL_JOURNALS` is `1`.
 */
export function journalLimitsFrom(environment) {
  const text = environment.ARC_LOCAL_JOURNAL_LIMITS;
  if (text === undefined || text === '') return undefined;
  if (environment.ARC_LOCAL_JOURNALS !== '1') throw new Error('ARC_LOCAL_JOURNAL_LIMITS needs ARC_LOCAL_JOURNALS=1.');
  let limits;
  try { limits = JSON.parse(text); } catch { throw new Error('ARC_LOCAL_JOURNAL_LIMITS must be a JSON object.'); }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('ARC_LOCAL_JOURNAL_LIMITS must be a JSON object.');
  for (const [name, value] of Object.entries(limits)) {
    if (!journalLimitNames.includes(name)) throw new Error(`ARC_LOCAL_JOURNAL_LIMITS has no limit named ${name}.`);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ARC_LOCAL_JOURNAL_LIMITS ${name} must be a positive whole number.`);
  }
  return limits;
}
