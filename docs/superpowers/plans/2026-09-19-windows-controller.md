# Windows Controller Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Checkboxes describe future work, not completed support.

**Goal:** Support the existing Controller commands on native Windows with current-user login startup, observable recovery, authenticated local management, and reliable cleanup of owned processes.

**Architecture:** Add a Task Scheduler adapter alongside launchd and systemd. Use a Windows-only Koffi binding to Job Objects for process ownership, Node named pipes for local management, and Windows ACLs for private state. Preserve the Remote protocol and keep platform mechanics out of Provider event normalization and the web renderer.

**Tech stack:** Node.js 22+, TypeScript, Windows Task Scheduler 2.0, Windows PowerShell 5.1, Koffi, Win32 Job Objects, Vitest, and the existing package smoke tests.

**Spec:** The design contract below is the specification for this plan. Existing behavior is documented in [Controller README](../../../packages/agent-host/README.md), [Relay architecture](../../current/agent-remote/relay.md), [VS Code tunnel lifecycle](../../current/agent-remote/host-vscode-tunnel.md), and [Codex shared runtime](../../current/agent-remote/codex-shared-runtime.md).

## Design contract

- Target native Windows 11 x64 first. Treat Windows ARM64 as a separate acceptance target; a dependency's ARM64 binary does not establish Controller support. WSL remains a Linux deployment, not evidence of native Windows compatibility.
- Preserve `foreground`, `start`, `status`, `pair`, `stop`, and `autostart enable|disable|status`. Preserve macOS and Linux behavior.
- Default to the current user's non-elevated interactive logon task. Do not request, store, or embed a Windows password. Installation must not silently switch to LocalSystem or a different account.
- `start` installs/enables login startup and starts the task unless autostart was explicitly disabled. `stop` stops the current instance but retains future login startup. `autostart disable` stops the managed instance, removes the task, and persists the disabled preference. A manually started instance follows the existing enable/disable semantics.
- Configure failure recovery explicitly: three retries at one-minute intervals. After exhaustion, remain offline with diagnostic evidence until explicit `start` or the next logon. This bounded Windows policy differs from launchd/systemd continuous recovery and must appear in CLI help and documentation. Do not add a permanent polling watchdog in this implementation.
- Normal `stop` must exit successfully without triggering failure recovery. Unexpected termination must be distinguishable from a requested stop. Verify Task Scheduler's actual exit-code behavior on Windows, including forced termination; configuration alone is not acceptance evidence.
- If Task Scheduler is unavailable or blocked by policy, a first-time `start` may warn and fall back to a manual background process, matching Linux. Explicit `autostart enable`, an existing managed task, or a saved managed instance must fail clearly instead of creating a second Controller.
- Every Controller-owned native process must be contained before it executes user work. Controller death must release owned descendants, including `code tunnel`; external shared daemons and manually launched tunnels must survive. A Job Object is a lifecycle boundary, not a filesystem sandbox.
- Keep the current five-minute default tunnel reclamation grace period for Relay disconnection. Brief disconnection preserves the tunnel; expiry closes its owned process tree. Reconnection does not implicitly start a user-stopped tunnel.
- Do not ship Windows managed execution if ownership setup fails. An unavailable native dependency or rejected Job assignment is a visible startup error, not permission to spawn uncontained processes.
- Keep credentials in private state, not task XML, command arguments, or diagnostic logs. Keep existing log size/rotation limits. Windows ACL enforcement replaces assumptions based on POSIX mode bits.
- No public Remote protocol change is planned. Provider support is reported individually. Codex private/stdio is the initial acceptance path; shared daemon mode stays explicitly unsupported on Windows until its native endpoint and reconnect behavior are verified.
- UNC/network workspaces are outside the initial support target. Reject them explicitly rather than treating them as web URLs or implicitly contacting a network share. Support local drive paths, relative file references, and local `file:///C:/...` URLs.
- This document does not implement, deploy, or certify Windows support. Source changes, dependency selection, and real Windows acceptance belong to subsequent implementation work.

## Verified gaps in the current implementation

| Boundary | Current source | Required change |
|---|---|---|
| Local management | `packages/agent-host/src/cli.ts` constructs a temporary `.sock`, calls `chmod`, and unlinks it | Platform endpoint adapter; Windows pipe lifetime is not file lifetime |
| Shutdown | `handleManagement` signals its own PID with `SIGTERM` | Direct idempotent shutdown shared by management and signal handlers |
| Startup | `loginStartup` selects only launchd/systemd | Task Scheduler adapter plus Windows supervisor state |
| Owned tunnel | `vscode-tunnel.ts` disables Windows; supervisor uses negative PID process groups | Job Object containment before enabling the capability |
| Native execution | Codex `native.ts` calls `spawn`; build script calls `execFile` on `.cmd` | Explicit executable resolution and argument-safe Windows invocation |
| Credentials and logs | Private writes and log rotation rely on POSIX permissions/rename behavior | ACL protection and bounded handling of Windows sharing violations |
| Resource paths | Browser `isLocalLocator` treats a drive prefix as a URL scheme; local reader rejects it too | Coordinated browser classification and Host-side path authorization |
| Shared Codex | Default endpoint is `app-server-control/app-server-control.sock` | Capability gate until a native Windows endpoint is proven |

## Module boundaries and proposed interfaces

New files below are proposed; existing paths in the task lists are implementation anchors. Keep lifecycle helpers inside `agent-host` unless a second package actually needs them. Do not introduce a general platform framework.

```ts
// packages/agent-host/src/local-management.ts
interface ManagementEndpoint {
  address: string;
  prepare(): Promise<void>;
  secure(): Promise<void>;
  dispose(): Promise<void>;
}
// packages/agent-host/src/windows-job.ts
interface OwnedWindowsJob {
  terminate(exitCode: number): void;
  close(): void;
}
// Establish containment before any Provider or tunnel subprocess is created.
function initializeWindowsOwnership(): Promise<void>;
// packages/agent-host/src/private-state.ts
function ensurePrivateStateDirectory(path: string): Promise<void>;
// packages/agent-host/src/windows-task.ts
// Match the existing adapters: available/status/install/start/stop/disable.
```

The ownership bootstrap creates an unnamed, non-inheritable Job handle, sets `KILL_ON_JOB_CLOSE`, and assigns the current serving Controller to it before Provider initialization. The Controller retains the sole handle for its lifetime; it must not close that handle while still serving because the Controller itself belongs to the Job. Child processes inherit membership, not the handle. Normal termination closes resources first, then process exit lets the OS close the handle. External daemons are never assigned to this Job.

Tunnel supervisors establish a nested Job before launching the native tunnel. The nested Job permits reclaiming just the tunnel when its timer or explicit stop fires; the outer Job remains the crash backstop. Job flags must prohibit breakaway. Test nested-job compatibility with actual Provider sandboxes. If this bootstrap design is incompatible with a supported Provider, revise this ownership design before enabling Windows support; do not replace it with spawn-then-assign, which leaves a creation race.

## Implementation sequence

### Local management and direct shutdown

**Files:** Create `packages/agent-host/src/local-management.ts` and `local-management.test.ts`; modify `cli.ts` and `cli.test.ts` in that directory.

- [ ] Add a platform endpoint factory. POSIX keeps the existing socket behavior; Windows uses a local `\\.\pipe\agent-remote-controller-<scope>-<pid>-<nonce>` endpoint. Pipe preparation/disposal never calls filesystem `rm` or `chmod` on that name. Include instance randomness and keep the token check.
- [ ] Extract one idempotent shutdown promise. The management `stop` operation acknowledges the request and invokes shutdown directly; signals also invoke it. Retain the existing shutdown deadline, log disposal, and generation-safe daemon state removal.
- [ ] Write a real pipe/server test for successful management, invalid token rejection, simultaneous stop requests, stale saved state, and a new instance that must not be removed by an old instance's cleanup.
- [ ] Run the new test on Windows and the socket equivalent on macOS/Linux. A platform shim cannot prove pipe behavior.

```ts
// Behavioral test shape; helpers must start a real isolated Controller fixture.
const host = await startControllerFixture();
await expect(host.request({ token: 'wrong', action: 'status' }))
  .rejects.toThrow(/Unauthorized/);
await Promise.all([host.stop(), host.stop()]);
await host.waitForExit();
expect(await host.readOwnedState()).toBeUndefined();
```

### Private state and Windows command execution

**Files:** Create `packages/agent-host/src/private-state.ts` and `private-state.test.ts`; modify `autostart-state.ts`, `connection-config.ts`, `diagnostic-log.ts`, and `cli.ts`. Inspect `packages/agent-provider-codex/src/native.ts`, Claude/Copilot SDK executable options, `scripts/build-agent-host.mjs`, and `scripts/run-tests.mjs` for invocation changes.

- [ ] Establish and verify a protected state-directory DACL before writing a token or pairing credential. Grant the current user and SYSTEM the required access, remove broad inherited access, and fail if the selected filesystem cannot enforce it. Do not modify Provider credential directories or unrelated ACLs.
- [ ] Preserve atomic private writes and generation checks. Retry only transient Windows sharing violations with a fixed deadline; never delete the destination credential file as a rename workaround. Exercise log rotation with an open reader and retain bounded disk usage.
- [ ] Resolve native `.exe` or explicit Node script entry points where available. Do not treat `codex.cmd`, `npm.cmd`, or `pnpm.cmd` as native `execFile` targets. Use the installed package's JS entry for repository runners; isolate unavoidable shell wrappers and reject arguments that cannot be safely represented.
- [ ] Test paths containing spaces, Unicode, `%`, `&`, parentheses, and quotes; verify the fixture receives exact argument boundaries and no extra process executes. Never interpolate user messages, credentials, or workspace paths into a PowerShell command string. Serialize configuration through a private file or stdin.
- [ ] Confirm `PATH`/`Path` handling and hidden-console behavior under a scheduled task. Missing Provider executables must yield a capability error without preventing unrelated supported Providers from being identified.

```ts
const args = ['C:\\Work space\\中文', 'literal&value', '%NOT_AN_EXPANSION%'];
expect(await runArgumentEchoFixture(args)).toEqual(args);
await writePrivateConnectionFixture();
expect(await readStateAclPrincipals()).toEqual(expectedPrivatePrincipals);
```

### Job Object ownership and tunnel reclamation

**Files:** Create `packages/agent-host/src/windows-job.ts` and `windows-job.test.ts`; modify `cli.ts`, `vscode-tunnel.ts`, `vscode-tunnel-supervisor.ts`, their tests, `packages/agent-host/package.json`, `pnpm-lock.yaml`, and `scripts/build-agent-host.mjs`.

- [ ] Pin a reviewed Koffi release after verifying its Node 22, Windows x64/ARM64 prebuilt artifacts and MIT license. Load it only on Windows and leave it external to esbuild. Include it in the distributable manifest and license notices; verify the package builder, which currently collects only Provider SDK dependencies, does not omit it.
- [ ] Implement the ownership bootstrap described above with `CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`, and checked Win32 errors. Verify structure alignment for each advertised architecture. Make setup idempotent; close a failed unassigned Job handle without leaking it.
- [ ] Call the bootstrap before any subprocess-producing Provider/tunnel initialization for both `_serve` and `foreground`. CLI commands such as `start` must not contain the long-lived daemon in the short-lived caller's Job.
- [ ] Replace the tunnel supervisor's POSIX-only containment with a Windows nested Job bootstrap. Keep stdout/stderr streaming, authorization parsing, native status probes, the disconnect grace period, and bounded output. Only remove the Windows capability block after the ownership test passes.
- [ ] Run a fixture that creates a child and grandchild, plus an unrelated sentinel. Force-terminate only the Controller PID and verify descendants exit while the sentinel survives. Repeat by killing only the tunnel supervisor, by graceful `stop`, and after the Relay grace deadline.
- [ ] Test Job assignment failure, missing Koffi binary, Provider nested sandbox Jobs, and repeated tunnel starts. Fail before native work is launched when containment cannot be established. Observe process handles/creation identity in tests rather than relying only on recycled PIDs.

```ts
const tree = await startOwnedProcessTreeFixture();
await forceTerminateControllerOnly(tree.controller);
await tree.child.waitForExit();
await tree.grandchild.waitForExit();
expect(await tree.unrelated.isAlive()).toBe(true);
```

### Current-user login task and recovery

**Files:** Create `packages/agent-host/src/windows-task.ts`, `windows-task.test.ts`, and `cli-windows.test.ts`; modify `cli.ts` and reuse `autostart-state.ts` without introducing a second credential store.

- [ ] Implement `available/status/install/start/stop/disable` with Task Scheduler COM accessed through a fixed PowerShell script. Use a deterministic task name based on user identity and the canonical state directory. Read structured input through stdin or a protected configuration file; return bounded JSON, not localized command output.
- [ ] Register a current-user logon trigger with `InteractiveToken`, least-privilege run level, and absolute Node/CLI paths. Use a stable existing working directory, persist the selected workspace separately, and omit credentials from the action. Disable execution-time limits and battery-only stop restrictions; prevent overlapping task instances. Do not require an already-working network to launch because the Host handles reconnection.
- [ ] Configure `RestartOnFailure` with `Count=3` and `Interval=PT1M`. All normal owner-requested stops exit zero. Verify failure, successful exit, forced termination, and exhausted retries against the real scheduler; report unavailable policies instead of silently changing account or privilege.
- [ ] Add `task-scheduler` to saved supervisor state. Reuse pending connection generation/revision safeguards. Preserve a running manual instance when enabling future login startup; require stop/start for supervisor takeover.
- [ ] On `stop`, request graceful shutdown first. If it exceeds the existing shutdown deadline, stop the exact scheduled instance and let Job containment reclaim its tree. Confirm no queued failure restart revives an intentionally stopped instance. `disable` also removes the task and saves the preference.
- [ ] Test missing task versus inaccessible manager separately. A manager error must not be interpreted as an absent installation. Check that repeated `start`, interrupted installation, and two concurrent commands cannot create duplicate instances.

```ts
await fixture.start();
expect((await fixture.status()).supervisor).toBe('task-scheduler');
await fixture.stop();
await fixture.assertStoppedAcrossRecoveryWindow();
expect((await fixture.autostartStatus()).enabled).toBe(true);
await fixture.disableAutostart();
expect((await fixture.autostartStatus()).installed).toBe(false);
```

### Provider capability and Windows resource paths

**Files:** Modify `packages/agent-provider-codex/src/provider.ts` and `native.ts`, `packages/agent-host/src/workspace-folders.ts` and `execution-policy.ts`, `packages/agent-remote-web/src/react/markdown-resources.tsx`, `packages/agent-remote-relay/src/resources/local-file-reader.ts` and `markdown-locators.ts`, and their existing tests. Inspect Claude/Copilot startup and the existing VS Code workspace-link helper before declaring their Windows capabilities.

- [ ] Accept rooted local drive paths before generic URL scheme parsing. Cover both slash styles, percent-encoded local file URLs, and relative references based on the source document. Keep `C:relative`, device namespaces, named pipes, alternate data streams, and UNC/network references rejected explicitly in the initial implementation.
- [ ] Preserve protocol-relative web URL behavior and the existing safe Markdown URL policy. A browser on iOS/macOS must still identify a Windows Host's resource locator; browser OS must not determine Host path syntax.
- [ ] Canonicalize and authorize on the Host. Test drive boundaries, parent traversal, directory junctions/reparse points, root aliases, and case handling without globally lowercasing case-sensitive directories. Retain regular-file checks, size limits, and opened-file identity checks; if a required Windows check is unreliable, reject that path class rather than weakening authorization.
- [ ] Exercise workspace browse/create under an allowed local drive root, including Unicode names. Do not invent permissions for drive roots outside the locally configured allowed roots.
- [ ] Verify Codex private/stdio with an installed native CLI. Report shared mode as unsupported on Windows before attempting the Unix default. A subsequent shared-mode change requires evidence of native endpoint discovery, authentication, and reconnect behavior; it is not a prerequisite for private-mode acceptance.
- [ ] Probe Claude/Copilot independently and run a real session for every Provider advertised as supported. Report unavailable Providers clearly. Validate native VS Code tunnel authorization and the generated Windows workspace URL using the installed CLI's behavior rather than guessing how a drive colon is encoded.

```ts
expect(isLocalLocator('C:/work/report.md')).toBe(true);
expect(isLocalLocator('file:///C:/work/report.md')).toBe(true);
expect(isLocalLocator('https://example.com/report.md')).toBe(false);
expect(await fixture.readOutsideRootViaJunction()).toMatchObject({ status: 'unavailable' });
```

## Verification and release gates

**Files:** Extend `scripts/agent-host-cli.test.mjs`, `scripts/agent-host-package.test.mjs`, `scripts/run-tests.mjs`, and `packages/agent-remote-lab/e2e/file-resources.browser.ts`. Update the Controller README, `docs/current/agent-remote/relay.md`, `host-vscode-tunnel.md`, `security.md`, `provider-support.md`, and `codex-shared-runtime.md` only after the corresponding behavior is implemented and observed.

- [ ] Add portable fixture executables using Node scripts instead of shell-only stubs. Make package installation/build/test command invocation work from a standard Windows terminal. The test deadline itself must reclaim fixture descendants on Windows.
- [ ] Unit-test platform selection, task configuration, executable resolution, and path classification. Use actual pipes, processes, ACLs, and scheduled tasks for lifecycle acceptance; mocked `process.platform` is only branch coverage.
- [ ] Run the full Controller suite, affected Provider/resource/renderer suites, typechecks, and distributable build. Run the tarball installation smoke from a fresh directory with real dependencies and no workspace symlinks. Add and document `AGENT_HOST_TEST_REQUIRE_WINDOWS_TASK=1` so Windows acceptance cannot silently pass through the manual fallback.
- [ ] Keep per-test deadlines at 10 seconds for unit tests and use explicit longer limits for process fixtures. Use an outer process deadline for every suite. The existing root test runner has a 540-second deadline; preserve it when making its Windows invocation portable.
- [ ] Run real Windows 11 x64 acceptance as a normal user. Repeat the package/ownership suite on Windows ARM64 before advertising ARM64 support. Record OS, architecture, Node, Koffi, CLI versions, and actual Provider coverage without recording credentials or device codes.
- [ ] Re-run macOS launchd and Linux systemd/manual-fallback acceptance because shutdown, private state, and packaging are shared. Keep Linux real-systemd acceptance distinct from the existing macOS-hosted Linux branch test.
- [ ] Run `pnpm compatibility:update` after implementation and then `pnpm compatibility:check`; inspect derived changes. Run documentation lint and `git diff --check`. A docs-only plan commit does not require changing the compatibility digest.

Use these repository commands after the runner's Windows adaptations are in place:

```text
pnpm test
pnpm typecheck
pnpm build:agent-remote-controller
pnpm test:agent-remote-controller-package
pnpm test:preview-browser
pnpm compatibility:update
pnpm compatibility:check
pnpm lint:docs
```

For the build, typecheck, and documentation commands, the implementation runner must also impose an outer deadline (180 seconds for typecheck, 300 seconds for build, 180 seconds for docs lint). Package tests keep their existing 180-second per-test limit; scheduler recovery tests must fit within a separately declared 480-second test deadline and a 540-second suite deadline. Do not speed up acceptance by changing the production scheduler retry interval below its supported minimum.

| Real Windows scenario | Required observation |
|---|---|
| Fresh install and first pairing | Private credential state, one task, one Controller, Relay registration |
| `start` twice and concurrent `start` | One authenticated instance; no orphan launch |
| Terminal closed | Managed Controller remains available without a visible console window |
| Windows reboot and user login | Controller registers without another pairing operation |
| User logged out | No promise of continued service under interactive-token mode; document observed shutdown/restart behavior |
| Controller-only force termination | Owned descendants exit; task recovers within configured policy; unrelated processes survive |
| Three failed retries | Recovery stops visibly; explicit `start` or next logon can recover |
| Explicit `stop` | All owned resources reclaimed; no restart during the recovery window; login preference retained |
| `autostart disable` then `start` | No task; manual instance works with Job containment; next login does not autostart |
| Relay unavailable and restored | Heartbeat/reconnect state accurate; uncertain side effects not automatically replayed |
| Prolonged Relay loss with active tunnel | Tunnel process tree reclaimed after grace period; external tunnel untouched |
| Task Scheduler unavailable | New manual fallback warns; existing managed state never silently duplicates |
| Missing Provider or `code tunnel` | Accurate unavailable capability; no hanging process or misleading active link |
| Windows paths viewed from mobile browser | Markdown/image/code preview, authorization, and stable placeholders work |
| Stop while logs/resources are being read | Bounded shutdown and disk use; no corrupted credentials or leaked handles |

Each implementation task should first reproduce its missing behavior with a failing behavioral test, then implement, run the relevant checks, and review the diff before committing. Do not create tests that merely search source text. Fixture helpers in the examples must create isolated temporary state, capture process identity, register unconditional cleanup, and expose the lifecycle operations shown; they must never connect to a production Relay or reuse a real Controller's task/state directory.

## Deferred capabilities and operational boundaries

Windows services/WinSW, operation before user login, UNC/network workspaces, Windows Server certification, and native Codex shared endpoint support are separate follow-ups. None is implied by completing the initial native Windows target. Do not automatically install WSL, elevate privileges, change execution policy, modify firewall settings, or take over an existing VS Code tunnel.

The Windows implementation will require a new Controller artifact and installation on the target Windows Host. Deploy web changes only if the resource-path implementation changes the renderer; no Relay deployment is required solely to install a Windows startup adapter. Use explicit release authorization for those later deployments. This plan's publication does not replace any running Controller.

## Research references

- [Koffi supported platforms and prebuilt binaries](https://koffi.dev/): candidate FFI dependency; its support matrix is not application acceptance.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): membership inheritance, nested Jobs, breakaway, and last-handle cleanup.
- [CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw): handle ownership and security.
- [Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks): current-user interactive token and least privilege.
- [Task Scheduler RestartOnFailure](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element): bounded retry configuration.
- [Node IPC support](https://nodejs.org/api/net.html#ipc-support): Windows named pipes and POSIX sockets.
- [Node Windows command execution](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows): `.cmd`/`.bat` invocation constraints.
- [WinSW runaway process recovery](https://winsw.github.io/v2/doc/extensions/runawayProcessKiller/): startup cleanup does not establish immediate cleanup after wrapper death.
