# Implementation plan

1. Add failing adapter tests for SDK command discovery, validation, native invocation and operation serialization. Implement commands behind the existing AgentSession methods.
2. Add failing tests for direct native child tracking, parent-scoped identity, independent history/live observations and read-only lifetime. Implement adapter-owned child projections and isolated SDK catalog discovery.
3. Route Host openChild through the loaded Claude parent. Verify ownership and no independent native process creation.
4. Extend real CLI loopback acceptance and browser coverage for skills and child navigation. Preserve existing services and use free test ports.
5. Update documentation/degradation evidence, build/typecheck, run bounded full suites and conformance, update/check compatibility, review and commit in the feature worktree.
