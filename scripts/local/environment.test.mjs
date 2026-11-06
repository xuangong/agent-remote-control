import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerEnvironment } from './environment.mjs';

const instance = { controller: '/dev/i/controller', workspace: '/dev/i/workspace', record: { source: '/src/.worktrees/feature-x' } };
const allowedParentVariables = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'PATH'];
const instanceVariables = ['AGENT_HOST_STATE_DIR', 'AGENT_HOST_WORKSPACE', 'AGENT_HOST_ALLOWED_WORKSPACE_ROOTS', 'AGENT_HOST_NAME',
  'AGENT_HOST_TRUSTED_FULL_CONTROL', 'AGENT_HOST_CODEX_AUTO_START', 'AGENT_HOST_OPENCODE_AUTO_START'];
const defaultPath = '/usr/bin:/bin:/usr/sbin:/sbin';

test('passes only the allowlisted parent environment', () => {
  const environment = controllerEnvironment({
    HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TMPDIR: '/tmp/me', SSH_AUTH_SOCK: '/tmp/agent', https_proxy: 'http://proxy',
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', AGENT_HOST_SERVER: 'https://production.example', AGENT_WINDOW_TOKEN: 'grant',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_HOME: '/elsewhere', npm_lifecycle_event: 'local', PATH: '/usr/bin',
    GATEWAY_TOKEN: 'gateway', RELAY_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'key', OPENAI_API_KEY: 'key',
    NODE_OPTIONS: '--require x', XDG_CONFIG_HOME: '/home/me/.config', SHELL: undefined,
  }, instance);
  assert.deepEqual({ HOME: environment.HOME, USER: environment.USER, LANG: environment.LANG, LC_ALL: environment.LC_ALL, LC_CTYPE: environment.LC_CTYPE,
    TMPDIR: environment.TMPDIR, SSH_AUTH_SOCK: environment.SSH_AUTH_SOCK, https_proxy: environment.https_proxy },
  { HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TMPDIR: '/tmp/me', SSH_AUTH_SOCK: '/tmp/agent', https_proxy: 'http://proxy' });
  for (const key of ['AGENT_WINDOW_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'npm_lifecycle_event', 'GATEWAY_TOKEN', 'RELAY_URL',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'XDG_CONFIG_HOME']) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.AGENT_HOST_SERVER, undefined);
  assert.equal(Object.hasOwn(environment, 'SHELL'), false);
  const allowed = new Set([...allowedParentVariables, ...instanceVariables]);
  assert.deepEqual(Object.keys(environment).filter(key => !allowed.has(key)), []);
});

test('pins restricted control over any inherited value', () => {
  assert.equal(controllerEnvironment({ AGENT_HOST_TRUSTED_FULL_CONTROL: '1' }, instance).AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  assert.equal(controllerEnvironment({}, instance).AGENT_HOST_TRUSTED_FULL_CONTROL, '0');
  // Restricted shared Codex refuses to run, so its trust setting stays at the Controller default.
  assert.equal(Object.hasOwn(controllerEnvironment({ AGENT_HOST_CODEX_TRUST_SHARED: '0' }, instance), 'AGENT_HOST_CODEX_TRUST_SHARED'), false);
});

test('removes package-manager shims from PATH', () => {
  const PATH = ['/repo/node_modules/.bin', '/usr/local/bin', '/repo/packages/x/node_modules/.bin', '', '/usr/bin'].join(':');
  assert.equal(controllerEnvironment({ PATH }, instance).PATH, '/usr/local/bin:/usr/bin');
});

test('keeps PATH entries that only resemble node_modules', () => {
  assert.equal(controllerEnvironment({ PATH: '/repo/node_modules_old/bin:/usr/bin' }, instance).PATH, '/repo/node_modules_old/bin:/usr/bin');
});

test('falls back to the system PATH when no entry remains', () => {
  assert.equal(controllerEnvironment({}, instance).PATH, defaultPath);
  assert.equal(controllerEnvironment({ PATH: '' }, instance).PATH, defaultPath);
  assert.equal(controllerEnvironment({ PATH: '/repo/node_modules/.bin:/x/node_modules/.bin' }, instance).PATH, defaultPath);
});

test('confines the Controller to the instance', () => {
  const environment = controllerEnvironment({}, instance);
  assert.equal(environment.AGENT_HOST_STATE_DIR, '/dev/i/controller');
  assert.equal(environment.AGENT_HOST_WORKSPACE, '/dev/i/workspace');
  assert.equal(environment.AGENT_HOST_ALLOWED_WORKSPACE_ROOTS, JSON.stringify(['/dev/i/workspace']));
  assert.equal(environment.AGENT_HOST_NAME, 'Dev · feature-x');
  assert.equal(environment.AGENT_HOST_CODEX_AUTO_START, '0');
  assert.equal(environment.AGENT_HOST_OPENCODE_AUTO_START, '0');
});
