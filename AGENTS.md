# Agent Remote Control Collaboration

Write code, comments, and documentation in English. Respond to the user in Chinese.

- Make changes in a dedicated worktree under `.worktrees/`; keep the main checkout available for normal use.
- Keep the Provider SDK, public Remote protocol, Relay state, native adapters, and client renderer as separate boundaries. Native runtime interpretation belongs in adapters.
- The standalone workbench has no account system. Pairing keys are temporary and process-local. Never add hidden dependencies on Borgee services, source paths, workspace packages, or user credentials.
- Keep protocol fixtures, replay behavior, public schemas, and compatibility metadata synchronized with contract changes.
- Run `pnpm compatibility:update` after reviewed implementation changes, then verify `pnpm compatibility:check`.
- Use per-test and outer process deadlines for every test run. Root test commands already enforce both.
- Test observable behavior rather than source text. Use real transports for changes to protocol, pairing, or reconnect behavior.
- Preserve existing local services and untracked user material. Use configurable free ports for local validation.
- Keep readable conversation rendering primary; Trace and Replica Inspector support diagnosis.
- Write large files in chunks. Name code by business meaning and keep process history out of comments.
- Do not publish packages, push, or create a remote repository unless the user asks.
