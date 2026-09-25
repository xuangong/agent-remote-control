# OpenCode Provider

An independent Provider SDK adapter for an existing `opencode serve` process. It uses the official pinned `@opencode-ai/sdk` client with the established `/session` and `/global/event` endpoints. Cross-project catalog listing uses the official `/experimental/session` endpoint and follows its native pagination cursor. No native process is launched, stopped, or upgraded.

```ts
import { OpenCodeAgentProvider } from '@orchardworks/agent-provider-opencode';

const provider = new OpenCodeAgentProvider({ serverUrl: 'http://127.0.0.1:4096' });
const session = await provider.createSession({ sessionId: 'local-id', cwd: '/workspace' });
for await (const observation of session.observe()) {
  // Feed normalized observations to the existing Session View.
}
```

Each provider multiplexes one global SSE connection. Sessions declare shared control. Closing a session or provider only detaches local observation; only explicit `cancel()` calls native abort. A disconnected stream changes connection state and triggers authoritative reconciliation, without completing or failing the native turn. POST requests are never automatically replayed, including uncertain timeouts.

The adapter normalizes native text, reasoning, tools/results, todos, compaction, usage, interactions, and runtime status. Usage uses native authoritative aggregates when supplied and otherwise describes the latest useful model step; it does not invent session totals from a bounded history window. Model context capacity comes from the native catalog. It reads the latest 200 native messages initially and supports older timeline pages. Native message/part identities drive live deltas; corrected history uses complete timeline replacements. Reconciliation buffers change notifications and refreshes again when needed to avoid replaying deltas already included in a snapshot.

Model, agent, model-specific variant, and permission selections persist in the native session and synchronize across clients. Variants retain their native meaning rather than being presented as universal Codex reasoning effort. Native skills, commands, MCP prompts and manual compaction use the server catalog and APIs.

Immediate input and `steer()` preserve the legacy conversation during model and tool execution without aborting it. A separate next-turn queue is not advertised. Native prompt editing forks before a validated user message; it never reverts the original workspace.

Custom Host callback tools and dynamic Ask source reads require explicit installation of the bundled native plugin. Callbacks use trusted native session context and private authenticated loopback HTTP; ordinary MCP arguments are not authorization. See [callback setup](../../docs/opencode-callbacks.md). Unconfigured servers remain usable for ordinary sessions.

Image input is validated against the shared Provider SDK limits, file type and digest, then sent inline. Resource reads expose bounded native inline images and native local output files through validated locators when using a loopback server; arbitrary filesystem paths and HTTP attachment URLs are not fetched. Shell metadata and native diffs use the existing normalized tool-result representation.

Server URL and HTTP Basic credentials are local constructor options. They never enter persistence handles or normalized observations. Shared native servers own their execution and permission policy; `restrictedNative: true` fails closed because the Host cannot impose a sandbox on another process. Explicit tool approvals are supported when the server is trusted.
