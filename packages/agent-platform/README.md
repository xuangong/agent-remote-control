# Agent platform capabilities

Node-only filesystem primitives shared by the Controller and standalone Relay.
There are no provider, protocol, account, or browser dependencies.

`atomicWriteFile(path, contents, mode = 0o600)` flushes a unique same-directory
temporary file, renames it, and synchronizes the parent directory on POSIX. Windows
does not expose directory flushing through Node; file flushing still applies.
Windows transient sharing errors receive bounded retries. The caller creates the
directory and owns serialization, quotas, and schema validation. A failure after
rename may mean the new value is already visible; do not replay business mutations.

`filesystemFor()` exposes native directory synchronization and rename operations.
Rename callers supply retry bounds. Selecting an OS explicitly is for deterministic
policy tests; only tests on that OS establish its real filesystem behavior.

These primitives do not elevate permissions, modify Windows ACLs, or guarantee
power-loss durability beyond the operating system's supported flush operations.
