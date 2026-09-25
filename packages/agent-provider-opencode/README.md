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

The adapter normalizes native text, reasoning, tools/results, todos, compaction, usage, interactions, and runtime status. Usage reports the latest native model step; it does not claim a session cost total from a bounded history window. It reads the latest 200 native messages initially and supports older timeline pages. Native message/part identities drive live deltas; corrected history uses complete timeline replacements. Reconciliation buffers change notifications and refreshes again when needed to avoid replaying deltas already included in a snapshot.

Model and agent selections apply to the next prompt on this connection. Native user messages restore the most recent selection when a session is reopened and update it after another client sends input. Unsent local selections remain in the connection and its persistence handle; a directory reopen using only a native session ID cannot recover an unsent choice. The adapter exposes native configured commands. Queued delivery, steering, custom Host callback tools, and independent reasoning-effort settings are unsupported.

Image input is validated against the shared Provider SDK limits, file type and digest, then sent inline. Resource reads expose only bounded native inline images; arbitrary filesystem paths and HTTP attachment URLs are not fetched.

Server URL and HTTP Basic credentials are local constructor options. They never enter persistence handles or normalized observations. Shared native servers own their execution and permission policy; `restrictedNative: true` fails closed because the Host cannot impose a sandbox on another process. Explicit tool approvals are supported when the server is trusted.
