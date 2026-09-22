# macOS test handoff

Validate the platform refactor on an actual Mac. Run commands locally; no GitHub
Actions or release deployment is needed. The implementation is on `origin/main`
starting at commit `0b37a21`. Record the exact revision tested.

## Prepare an isolated checkout

Requirements: Git, Node.js >=22, pnpm 10.34.5, and a locally installed Codex CLI.
Use a normal macOS user session. Full package coverage needs a GUI login domain
for launchd; an SSH-only session without that domain is insufficient. Keep the
existing Controller and user sessions running.

From an existing repository checkout, run these commands in macOS Terminal:

```sh
git fetch origin
test_dir=".worktrees/macos-platform-$(date +%Y%m%d-%H%M%S)"
git worktree add --detach "$test_dir" origin/main
cd "$test_dir"
git rev-parse HEAD
git status --short
sw_vers
uname -m
node --version
pnpm --version
pnpm install --frozen-lockfile
```

Stop if dependency installation fails. Do not regenerate the lockfile to work
around an environment problem. Record whether Node is native arm64 or running
under Rosetta; the report records `process.arch`. Intel and Apple Silicon are
separate architecture evidence.

## Execute automated coverage

For the complete acceptance run:

```sh
export AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE="$(command -v codex)"
test -n "$AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE"
"$AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE" --version
set -o pipefail
mkdir -p .tmp
pnpm test:platform:macos --native --package 2>&1 | tee .tmp/macos-platform.log
pnpm compatibility:check
```

If `codex` is not on PATH, replace the export value with the absolute path to the
installed executable. Do not continue past a failed executable/version check.
Do not run `compatibility:update` simply to make an acceptance check pass; report
any mismatch against the committed manifest.

For a shorter first diagnostic pass, `pnpm test:platform:macos` runs the baseline
without native Codex and standalone installation. This is not full acceptance.

The complete profile builds dependencies and checks:

| Area | Expected behavior |
| --- | --- |
| Filesystem | Atomic replacement, complete concurrent reads, POSIX private modes and directory sync, cleanup after failure |
| Persistence and images | Credentials/update staging retain their contracts; image upload succeeds over a real WebSocket |
| Processes | Owned processes are reclaimed; shared processes survive client disposal; tunnel and launcher behavior is preserved |
| launchd configuration | Correct plist and lifecycle command construction; platform factory chooses launchd |
| Native Codex | Real shared daemon with a local mock model endpoint; multi-client state, detach/resume, and Controller restart behavior |
| Standalone package | Fresh tarball builds, installs outside the repository, and manages its isolated paired daemon |

Native tests use temporary homes and a local mock model endpoint; production
credentials and paid model requests are unnecessary. Package tests use isolated
state and clean up their own service. Tests have per-test deadlines, suite
deadlines, and a fifteen-minute profile deadline.

## Failures and targeted retries

Keep the original failed report. Fix the diagnosed cause and rerun the affected
suite, recording the retry separately. If npm dependency download times out,
select a registry reachable from the Mac and retry only the package suite:

```sh
npm_config_registry=https://registry.npmjs.org pnpm test:agent-remote-controller-package
```

This focused command uses the tarball already built by the full profile. If the
profile never reached package construction, first run
`pnpm build:agent-remote-controller`. Do not substitute a previously released
tarball for the refactored build. If launchd is unavailable, rerun from Terminal
inside an interactive macOS login and preserve the original diagnostics.

## Manual checks in a dedicated test account

Automated launchd fixtures do not prove startup after login. Use a separate test
account or disposable VM for these checks; logging out of the normal account
would interrupt existing tasks. Use the freshly built package, test Controller
state, and a test Relay configuration.

1. Enable autostart. Confirm the account's LaunchAgents plist and loaded service
   correspond to the test Controller state directory.
2. Log out and in. Confirm exactly one test Controller comes online with the
   correct Host name, workspace, and saved configuration.
3. Open one shared Codex session from the native client and website. Verify image
   upload, permission changes, disconnect/reconnect, and synchronized session state.
4. If two test release versions are available, exercise update discovery, update,
   restart, and reconnection. Otherwise report live upgrade as **not tested**;
   building the current tarball is not proof of a live upgrade.
5. Disable the test autostart service. Log out and in again and verify it remains
   stopped. Remove only the test account's installation and state.

## Return these results

Send `.tmp/macos-platform.log`, the exact report directory printed by the runner
(`.tmp/platform-tests/macos-<timestamp>/`), and the following completed template.
Review logs for credentials before sharing. Do not include real connection files,
pairing keys, tokens, or user session contents.

```text
Commit:
Working tree clean (yes/no):
macOS version:
Hardware architecture / Node architecture / Rosetta:
Node / pnpm / Codex versions:
Full profile command and exit status:
Suite pass/fail/skip counts (from summary.json):
Compatibility check:
Package install / launchd results:
Manual login / shared-session UI / live upgrade results:
Original failures and focused retry results:
Report directory and sanitized log:
```

Acceptance requires a clean committed revision, passing required suites and
compatibility check, and no skipped required native assertions. Record manual
checks separately as passed, failed, or not tested. Never infer Mac success from
Windows results. See [the cross-platform matrix](platform-testing.md) for the
overall release gate.
