# Platform boundaries and machine validation

## Implementation plan

1. Introduce `@orchardworks/agent-platform`, a Node-only package with no provider,
   protocol, Relay, account, or UI dependencies. Begin with filesystem capabilities:
   flushed atomic file replacement, directory synchronization, and bounded rename
   retries. Select Windows or POSIX implementations at the package boundary.
2. Migrate connection credentials, autostart state, image manifests, and Controller
   package publication to these capabilities. Preserve caller-owned serialization,
   quotas, schemas, private modes, and update error messages.
3. Group Host service implementations by capability and OS under
   `src/platform/services/{windows,macos,linux}.ts`, executable resolution under
   `src/platform/executables/`, and Windows process ownership under
   `src/platform/processes/`. Keep service selection behind a Host-level factory.
4. Keep Codex-specific daemon interpretation in the Codex adapter. Group its
   Windows implementation under that adapter's platform directory; do not move
   native protocol behavior into the shared system package. Isolate owned process
   shutdown in the daemon client without adding a dependency on Host internals.
5. Add native-machine test profiles, shared capability contracts, and reproducible
   evidence files. Run the Windows profile here; record macOS and Linux as pending
   until their actual machines execute the same revision.

## Boundary rules

- Business code calls named capabilities; platform selection belongs at a system
  boundary. OS identity in release manifests and environment reports remains data.
- POSIX implementations are shared when macOS and Linux semantics agree. Service
  management remains separate because launchd and systemd have different contracts.
- Keep native executable resolution rules with the Host, and daemon endpoints with
  the native adapter. Do not introduce a single platform class owning all concerns.
- No protocol, persistence schema, native permission policy, or service activation
  change is intended. New shared helpers use package exports, never source-path
  imports. Standalone bundles must include their runtime dependencies.
- Source-file moves and system capability extraction are separate from redesigning
  the standalone launcher and shell installers. Those bootstrap artifacts keep
  their dependency-free contracts and retain dedicated regression coverage.

## Acceptance criteria

- Image upload and credential writes share one directory-sync policy.
- Windows transient rename handling has one implementation and explicit bounded
  caller policies; unrelated errors propagate immediately.
- Filesystem contracts run against real temporary directories on each native OS.
- Host service selection and executable resolution have explicit capability entry
  points. Native-specific behavior remains owned by its adapter.
- Test commands reject an OS profile on the wrong OS and apply per-test and outer
  process deadlines. Reports identify revision, dirty state, OS, architecture,
  Node version, profile, and suite outcomes.
- The final machine matrix distinguishes automated fixtures, actual native Codex,
  and manual login/service-manager lifecycle checks. Mocked OS branches never count
  as proof of native filesystem or process behavior.

The execution matrix and exact commands are defined in
[platform testing](platform-testing.md).
