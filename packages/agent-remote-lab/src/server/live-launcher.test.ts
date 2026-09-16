import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = process.cwd();
const launcher = join(packageRoot, 'scripts/run-live-dsh.sh');

describe('live DSH launcher', () => {
  let testRoot: string;
  let dshRepo: string;
  let fakePnpm: string;
  let fakeGit: string;
  let pnpmLog: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'borgee-live-launcher-test-'));
    dshRepo = join(testRoot, 'dsh');
    mkdirSync(join(dshRepo, 'apps/cli/src'), { recursive: true });
    writeFileSync(join(dshRepo, 'package.json'), '{"name":"test-dsh","version":"0.1.2-rc.1"}\n');
    writeFileSync(join(dshRepo, 'apps/cli/src/bin.ts'), '');
    writeFileSync(join(dshRepo, 'tsconfig.json'), '{}\n');
    writeFileSync(join(testRoot, 'implementation.txt'), 'implementation\n');

    pnpmLog = join(testRoot, 'pnpm.log');
    fakePnpm = join(testRoot, 'pnpm');
    writeFileSync(fakePnpm, '#!/usr/bin/env bash\nbuiltin printf \'%s\\n\' "$*" >> "$BORGEE_TEST_PNPM_LOG"\nif [[ -n "${BORGEE_TEST_PNPM_FAIL_MATCH:-}" && "$*" == *"$BORGEE_TEST_PNPM_FAIL_MATCH"* ]]; then exit "${BORGEE_TEST_PNPM_EXIT:-1}"; fi\nexit 0\n');
    chmodSync(fakePnpm, 0o755);
    fakeGit = join(testRoot, 'git');
    writeFileSync(fakeGit, '#!/usr/bin/env bash\nprintf \'%s\\n\' "${BORGEE_TEST_DSH_COMMIT:-a66e4702047846cdaa10c66c9d3df3951f5ea70d}"\n');
    chmodSync(fakeGit, 0o755);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('runs the caller-supplied pnpm executable', () => {
    const result = runLauncher({ BORGEE_TEST_PNPM_EXIT: '73', BORGEE_TEST_PNPM_FAIL_MATCH: '@agent-remote-controller/dsh' });

    expect(result.status, result.stderr).toBe(73);
    expect(readFileSync(pnpmLog, 'utf8')).toContain('--filter @agent-remote-controller/dsh run build');
  });

  it('validates compatibility when launched outside the Lab directory', () => {
    const result = runLauncher(
      { BORGEE_TEST_PNPM_EXIT: '73', BORGEE_TEST_PNPM_FAIL_MATCH: '@agent-remote-controller/agent-provider-dsh' },
      join(packageRoot, '../..'),
    );

    expect(result.status, result.stderr).toBe(73);
    expect(readFileSync(pnpmLog, 'utf8')).toContain('--filter @agent-remote-controller/agent-provider-dsh run build');
  });

  it('rejects a DSH checkout that is not the compatibility-manifest commit', () => {
    const result = runLauncher({ BORGEE_TEST_DSH_COMMIT: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('a66e4702047846cdaa10c66c9d3df3951f5ea70d');
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('runs the complete compatibility validator before invoking pnpm or Cordis', () => {
    const manifest = join(testRoot, 'invalid-compatibility.json');
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 2,
      protocolVersion: '1.4.0',
      borgee: { release: 'unreleased', revision: 'test' },
      providers: [{
        providerId: 'dsh',
        native: {
          name: '@deepseek-ai/dsh-agent', version: '0.1.2-rc.1',
          revision: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
        },
        degradations: [],
      }],
    }));

    const result = runLauncher({
      BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST: manifest,
      BORGEE_TEST_PNPM_EXIT: '73',
      BORGEE_TEST_PNPM_FAIL_MATCH: '@agent-remote-controller/agent-provider-dsh',
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('schemaVersion 1');
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('takes the required DSH revision from the selected compatibility manifest', () => {
    const manifest = writeSelectedManifest({ dshRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

    const result = runLauncher({ BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST: manifest });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('takes the required DSH version from the selected compatibility manifest', () => {
    const manifest = writeSelectedManifest({ dshVersion: '0.1.0-rc.7' });

    const result = runLauncher({ BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST: manifest });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('0.1.0-rc.7');
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('stops before writing the fixture when the first temporary directory fails', () => {
    const failure = failureEnvironment('first-fail');
    const result = runLauncher(failure.env);

    expect(result.status, result.stderr).toBe(91);
    expect(existsSync(failure.fixtureLog)).toBe(false);
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('cleans the workspace and stops when the plugin build directory fails', () => {
    const failure = failureEnvironment('second-fail');
    const result = runLauncher(failure.env);

    expect(result.status, result.stderr).toBe(92);
    expect(existsSync(failure.firstWorkspace)).toBe(false);
    expect(existsSync(failure.fixtureLog)).toBe(false);
    expect(existsSync(pnpmLog)).toBe(false);
  });

  it('does not create temporary directories or run pnpm after the DSH checkout cannot be entered', () => {
    const failure = failureEnvironment('cd-fail');
    const result = runLauncher(failure.env);

    expect(result.status, result.stderr).toBe(93);
    expect(existsSync(failure.mktempCount)).toBe(false);
    expect(existsSync(failure.fixtureLog)).toBe(false);
    expect(existsSync(pnpmLog)).toBe(false);
  });

  function writeSelectedManifest(overrides: { dshRevision?: string; dshVersion?: string }): string {
    const manifest = join(testRoot, 'compatibility.json');
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      protocolVersion: '1.4.0',
      borgee: {
        release: 'unreleased', sourceState: 'working_tree',
        baseRevision: '9e21c2ad9a0ba55413960a1681d34675c5d6e026',
        implementation: {
          algorithm: 'sha256', root: '.', scope: ['implementation.txt'],
          digest: 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15',
        },
      },
      providers: [
        {
          providerId: 'dsh',
          native: {
            name: '@deepseek-ai/dsh-agent',
            version: overrides.dshVersion ?? '0.1.2-rc.1',
            revision: overrides.dshRevision ?? 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
          },
          degradations: [
            { capability: 'events.session/title', status: 'degraded', reason: 'Not represented in the snapshot.' },
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Conditional cancel only; input remains unavailable.' },
            { capability: 'events.compaction.failure', status: 'degraded', reason: 'Failed compaction has no terminal replacement card.' },
            {
              capability: 'events.user-message.unknown-source', status: 'degraded',
              reason: 'Unknown sources are diagnostic.',
            },
          ],
        },
        {
          providerId: 'codex',
          native: { name: 'codex-cli', version: '0.148.0', revision: null },
          degradations: [
            { capability: 'interactions.form.schema', status: 'degraded', reason: 'Bounded flat schemas only.' },
            { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Native requests are process-local.' },
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Parent summary only.' },
            {
              capability: 'events.thread/name', status: 'degraded',
              reason: 'Thread names are not represented in the Agent Snapshot.',
            },
            {
              capability: 'events.commandExecution/terminalInteraction', status: 'degraded',
              reason: 'Terminal interactions are not represented in normalized tool detail.',
            },
          ],
        },
        {
          "providerId": "copilot",
          "native": {
            "name": "github-copilot-cli",
            "version": "1.0.83",
            "revision": null
          },
          "sdk": {
            "name": "@github/copilot-sdk",
            "version": "1.0.11"
          },
          "degradations": [
            {
              "capability": "native.experimental-rpc",
              "status": "degraded",
              "reason": "Public SDK model, skills, commands, tasks, metadata, permissions, interruptMainTurn and eventLog APIs are experimental; only CLI 1.0.83 is native-loopback verified. No ACP or private RPC transport."
            },
            {
              "capability": "controls.settings",
              "status": "degraded",
              "reason": "Model catalog is native/auth dependent and changes require idle state. Deferred writes remain unconfirmed until native application. Effort is creation-only; planning and permission-mode controls are unavailable."
            },
            {
              "capability": "events.subagent.navigation",
              "status": "degraded",
              "reason": "Children are task/eventLog views under the loaded parent. Repeated task input and cancellation are supported; approvals/questions stay on parent. No independent child queue, settings, resources, cold root resume or external spawn API."
            },
            {
              "capability": "interactions.callback-identity",
              "status": "degraded",
              "reason": "SDK question callbacks omit native request/agent IDs. Only unique complete-payload event matches bind; identical concurrent unbound questions fail explicitly. Pending callbacks are process-local; no sensitivity/form/plan/grant/external-action mapping."
            },
            {
              "capability": "events.resources-usage",
              "status": "degraded",
              "reason": "Tool output is bounded native text; skill Markdown uses refreshed native locators and bounded regular-file reads. Output images, todos, context capacity, cost and terminal control are not mapped."
            },
            {
              "capability": "controls.immediate-input",
              "status": "degraded",
              "reason": "SDK immediate input may become native queued delivery after the active interaction has ended. Native interactionId/delivery determine public turn grouping; adapter does not synthesize a queue."
            }
          ]
        },
        {
          providerId: 'claude',
          native: { name: 'claude-code', version: '2.1.247', revision: null },
          sdk: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.247' },
          degradations: [
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Nested agents remain parent tool summaries.' },
            { capability: 'events.tool-result.resources', status: 'degraded', reason: 'Binary resources are not exposed.' },
            { capability: 'controls.queue-steer-commands-settings', status: 'degraded', reason: 'No mid-turn input or command menus.' },
            { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Permission callbacks are process-local.' },
            { capability: 'sessions.empty-persistence', status: 'degraded', reason: 'An empty session may not be persisted.' },
            { capability: 'interactions.form.schema', status: 'degraded', reason: 'Native schema loss prevents form support.' },
          ],
        },
      ],
    }));
    return manifest;
  }

  function failureEnvironment(mode: 'first-fail' | 'second-fail' | 'cd-fail') {
    const canonicalTestRoot = realpathSync(testRoot);
    const bashEnvironment = join(testRoot, 'bash-env.sh');
    const fixtureLog = join(testRoot, 'fixture-attempt.log');
    const mktempCount = join(testRoot, 'mktemp-count');
    const failedWorkspace = join(canonicalTestRoot, 'borgee-live-dsh-workspace.failed');
    const firstWorkspace = join(canonicalTestRoot, 'borgee-live-dsh-workspace.first');
    mkdirSync(failedWorkspace);
    writeFileSync(bashEnvironment, [
      'mktemp() {',
      '  local count=0',
      '  if [[ -f "$BORGEE_TEST_MKTEMP_COUNT" ]]; then IFS= read -r count < "$BORGEE_TEST_MKTEMP_COUNT"; fi',
      '  count=$((count + 1))',
      '  builtin printf \'%s\\n\' "$count" > "$BORGEE_TEST_MKTEMP_COUNT"',
      '  if [[ "$BORGEE_TEST_MKTEMP_MODE" == "first-fail" ]]; then',
      '    builtin printf \'%s\\n\' "$BORGEE_TEST_FAILED_WORKSPACE"',
      '    return 91',
      '  fi',
      '  if [[ "$BORGEE_TEST_MKTEMP_MODE" == "second-fail" && "$count" -eq 1 ]]; then',
      '    /bin/mkdir -p "$BORGEE_TEST_FIRST_WORKSPACE"',
      '    builtin printf \'%s\\n\' "$BORGEE_TEST_FIRST_WORKSPACE"',
      '    return 0',
      '  fi',
      '  builtin printf \'%s\\n\' "$BORGEE_TEST_FAILED_WORKSPACE"',
      '  return 92',
      '}',
      'cd() {',
      '  if [[ -n "${BORGEE_TEST_FAIL_CD:-}" && "$1" == "$BORGEE_TEST_FAIL_CD" ]]; then return 93; fi',
      '  builtin cd "$@"',
      '}',
      'printf() {',
      '  if [[ "$*" == *live-dsh-fixture-content* ]]; then',
      '    builtin printf \'fixture write attempted\\n\' >> "$BORGEE_TEST_FIXTURE_LOG"',
      '    return 99',
      '  fi',
      '  builtin printf "$@"',
      '}',
      '',
    ].join('\n'));
    return {
      env: {
        BASH_ENV: bashEnvironment,
        BORGEE_TEST_FAIL_CD: mode === 'cd-fail' ? dshRepo : '',
        BORGEE_TEST_FAILED_WORKSPACE: failedWorkspace,
        BORGEE_TEST_FIRST_WORKSPACE: firstWorkspace,
        BORGEE_TEST_FIXTURE_LOG: fixtureLog,
        BORGEE_TEST_MKTEMP_COUNT: mktempCount,
        BORGEE_TEST_MKTEMP_MODE: mode,
      },
      firstWorkspace,
      fixtureLog,
      mktempCount,
    };
  }

  function runLauncher(overrides: NodeJS.ProcessEnv = {}, cwd = packageRoot) {
    return spawnSync('/bin/bash', [launcher], {
      cwd,
      encoding: 'utf8',
      timeout: 8_000,
      env: {
        ...process.env,
        BASH_ENV: '',
        BORGEE_LIVE_DSH_PNPM: fakePnpm,
        BORGEE_LIVE_DSH_GIT: fakeGit,
        BORGEE_TEST_PNPM_LOG: pnpmLog,
        DSH_REPO: dshRepo,
        TMPDIR: testRoot,
        ...overrides,
      },
    });
  }
});
