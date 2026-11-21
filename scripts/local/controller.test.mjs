import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerRefusal } from './controller.mjs';

const session = '01a1fbf7-86f8-73a1-bc0d-3bdc302c6b4a';

test('runs the Controller commands an instance answers and refuses the ones the runner or the user owns', () => {
  for (const args of [['session', 'list'], ['host', 'providers'], ['window', 'list'], ['api', 'GET', '/v1/remote/hosts'], ['login'], ['login', 'status'], ['--skill']]) {
    assert.equal(controllerRefusal(args), undefined, args.join(' '));
  }
  for (const [args, reason] of [[['start'], /runner owns start/], [['claude', '--resume', session], /other native CLIs could take over/],
    [['session', 'attach', `local/claude/${session}`], /session attach runs a native CLI/], [['host', 'update'], /run pnpm local up instead/],
    [['host', 'tunnel', 'start'], /only reports its status/], [['login', '--server', 'http://elsewhere'], /takes no options/]]) {
    assert.match(controllerRefusal(args) ?? '', reason, args.join(' '));
  }
});

test('lets codex join one existing session through the shared daemon, as another client of the session the page shows', () => {
  assert.equal(controllerRefusal(['codex', 'exec', 'resume', session, 'Reply with the single word OK.']), undefined);
  assert.equal(controllerRefusal(['codex', 'exec', 'resume', session]), undefined);
  assert.equal(controllerRefusal(['codex', 'resume', session]), undefined);
});

test('refuses codex for the daemon, the sign-in, a new session and any other choice of session or server', () => {
  for (const args of [['codex'], ['codex', 'daemon', 'restart'], ['codex', 'login'], ['codex', 'exec', 'Write a file.'], ['codex', 'exec', 'resume'],
    ['codex', 'exec', 'resume', '--last', 'again'], ['codex', 'resume', '--last'], ['codex', 'exec', 'resume', '--all', session],
    ['codex', 'exec', 'resume', session, '--remote', 'ws://elsewhere'], ['codex', 'exec', 'resume', session, '--remote=ws://elsewhere'],
    ['codex', 'resume', session, '-C', '/tmp'], ['codex', 'exec', 'resume', session, '--cd=/tmp'], ['codex', 'fork', session], ['codex', 'app-server', 'daemon', 'stop']]) {
    assert.match(controllerRefusal(args) ?? '', /only joins one session through the shared Codex daemon/, args.join(' '));
  }
});
