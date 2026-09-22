# Native platform testing

Run these profiles directly on Windows, macOS, and Linux machines. No GitHub
Actions workflow is required. Use the same committed revision on all machines;
dirty reports are useful during development but are not release evidence.

For a directly shareable Mac handoff, use [macOS test instructions](platform-testing-macos.md).

## Machine setup

Use a dedicated worktree, Node.js 22 or newer, and the repository's pinned pnpm.
Run `pnpm install --frozen-lockfile` first. Use an ordinary user account and keep
existing Controller services running: automated tests use temporary state and
ephemeral ports. Windows needs Windows PowerShell, taskkill, and Windows Script
Host. Native Codex tests require a separately installed Codex executable.

Record both OS and architecture. At minimum validate Windows x64, macOS arm64,
and Linux x64; validate additional advertised architectures on matching hardware
or VMs before claiming support. WSL results count as Linux, not Windows. macOS
service lifecycle checks need an interactive user login; Linux service lifecycle
checks need a working systemd user manager.

## Commands

Baseline profiles build dependencies and exercise real filesystem operations,
image upload over WebSocket, transport disposal, service configuration, and
platform-specific process supervision:

```sh
pnpm test:platform:windows
pnpm test:platform:macos
pnpm test:platform:linux
```

Run only the command matching the current OS. A mismatched profile fails before
tests start. The baseline deliberately disables optional native Codex tests.

For full Windows automation, use PowerShell and set the actual executable path:

```powershell
$env:AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE = "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe"
pnpm test:platform:windows --native --package
```

For macOS and Linux, respectively:

```sh
export AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE="$(command -v codex)"
pnpm test:platform:macos --native --package
# On a Linux machine:
pnpm test:platform:linux --native --package
```

`--native` records the Codex version and requires native assertions to pass; a
skipped native test is a failure. Windows checks multiple clients against an
isolated real daemon without model requests. POSIX tests use real Codex with a
local mock model endpoint, including detach/resume and Controller restart. These
tests do not need production credentials or paid model requests.

`--package` builds a fresh standalone tarball, then checks CLI behavior and
installation outside the workspace. It can need network access to the configured
npm registry. On the Linux service-validation machine, also set
`AGENT_HOST_TEST_REQUIRE_SYSTEMD=1` to require the real systemd path rather than
accepting its documented unavailable-manager behavior.

## Coverage and change triggers

| Changed capability | Required machines and checks |
| --- | --- |
| Shared filesystem, credential/image persistence, update publication | Baseline on all three OSes; package checks on all three |
| Windows sharing locks, executable lookup, process trees | Windows baseline and native; shared filesystem contract on POSIX |
| launchd or systemd configuration | Matching OS baseline, package checks, and service lifecycle below |
| Native daemon or owned-process disposal | All three native profiles; verify owned children stop and shared daemon survives |
| Public protocol, pairing, reconnect | Existing protocol/compatibility checks and real transport suites in addition to platform profiles |
| Installer or standalone launcher | Package checks and fresh-account install/upgrade/login checks on affected OSes |

Service configuration tests use command fixtures and real temporary files. They
do not prove that the OS starts the service after login. Likewise, mocked rename
errors prove retry policy, while real filesystem tests prove the native path.

## Manual service and upgrade acceptance

Use a disposable VM snapshot or dedicated test account so login and update tests
cannot interrupt a user's Host. Use a separate Controller state directory and a
test Relay configuration; never copy production credentials into test artifacts.

1. Install the freshly built tarball using the supported installer/launcher.
   Enable autostart and confirm the expected Windows login launcher, launchd
   agent, or systemd user unit exists for this account.
2. Log out and in. Confirm exactly one Controller connects, its full Host name is
   visible, and its working directory and saved configuration survive login.
3. Open a shared Codex session from two clients. Upload an image, change permission,
   detach/reconnect, and confirm both clients see the same session state.
4. Upgrade between two deliberately built test versions. Confirm version discovery,
   successful replacement, and reconnection. On Windows also hold a package
   directory open to verify a bounded failure leaves the running version usable,
   then release the handle and retry.
5. Disable autostart, confirm the test-owned service is removed, and log in again
   to verify it stays disabled. Remove only that account's test installation/state.

Attach pass/fail notes, exact versions, OS/architecture, and sanitized logs. Login,
real service-manager operation, and live upgrade results must be recorded separately
from automated fixture results.

## Evidence and deadlines

Every run writes `.tmp/platform-tests/<profile>-<timestamp>/summary.json` and
Vitest JSON reports. Preserve these artifacts outside the ignored directory for
review. The summary includes revision, dirty state, OS release, architecture,
Node/Codex versions, requested coverage, suite outcomes, timings, and test counts.
Keep console output with package results because those tests use Node's reporter.

Vitest defaults to 30 seconds per test and 15 seconds per hook; a few existing
integration tests explicitly allow 60 seconds. Each suite has a five-minute
outer deadline. Package tests have a three-minute per-test deadline and a
five-minute outer deadline. The complete profile has a fifteen-minute deadline
and terminates its active process tree on timeout.

After reviewed changes run `pnpm compatibility:update`, then
`pnpm compatibility:check`. A release candidate needs passing automated results
from all affected native OSes at the same clean revision, with skipped tests
explained and required manual checks completed. Windows success alone does not
establish macOS or Linux compatibility.

## Current refactor validation

On 2026-09-22, the implementation worktree passed 82 Windows tests with no skips
on Windows x64 (OS 10.0.26200), Node 24.16.0, and Codex 0.153.4. The report is at
`.tmp/platform-tests/windows-1790091677445/summary.json`. That combined report
retains its failed package outcome: dependency installation from npmjs timed out
after 120 seconds. A focused retry with
`pnpm test:agent-remote-controller-package` using the repository's default registry
passed all three package tests, including independent install and daemon management.
The build and compatibility update/check also passed.

These are development results from the dirty `refactor/platform-boundaries`
worktree based on `7a3546d`, not release certification. macOS and Linux execution,
additional architectures, and manual login/upgrade checks remain pending on
their respective machines.
