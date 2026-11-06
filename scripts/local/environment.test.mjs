import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerEnvironment } from './environment.mjs';

const instance = { controller: '/dev/i/controller', workspace: '/dev/i/workspace', record: { source: '/src/.worktrees/feature-x' } };

test('passes only the allowlisted parent environment', () => {
  const environment = controllerEnvironment({
    HOME: '/home/me', USER: 'me', LANG: 'en_US.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp/me', SSH_AUTH_SOCK: '/tmp/agent', https_proxy: 'http://proxy',
    AGENT_HOST_TRUSTED_FULL_CONTROL: '1', AGENT_HOST_SERVER: 'https://production.example', AGENT_WINDOW_TOKEN: 'grant',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_HOME: '/elsewhere', npm_lifecycle_event: 'local', PATH: '/usr/bin',
  }, instance);
  for (const key of ['HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SSH_AUTH_SOCK', 'https_proxy']) assert.ok(environment[key], key);
  for (const key of ['AGENT_HOST_TRUSTED_FULL_CONTROL', 'AGENT_WINDOW_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'npm_lifecycle_event']) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.AGENT_HOST_SERVER, undefined);
});

test('removes package-manager shims from PATH', () => {
  const PATH = ['/repo/node_modules/.bin', '/usr/local/bin', '/repo/packages/x/node_modules/.bin', '', '/usr/bin'].join(':');
  assert.equal(controllerEnvironment({ PATH }, instance).PATH, '/usr/local/bin:/usr/bin');
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
