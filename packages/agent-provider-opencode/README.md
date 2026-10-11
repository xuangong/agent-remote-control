# OpenCode Provider

An independent Provider SDK adapter for an existing OpenCode **2.0.25 or newer within 2.x** `serve` process. It uses the official pinned `@opencode/client` with `/api/session`, `/api/event` and opaque native pagination cursors. The adapter does not launch, stop or upgrade native processes; Controller can separately manage the shared server lifecycle.

```ts
import { OpenCodeAgentProvider } from '@orchardworks/agent-provider-opencode';

const provider = new OpenCodeAgentProvider({
  serverUrl: 'http://127.0.0.1:4096',
  password: process.env.AGENT_HOST_OPENCODE_PASSWORD,
});
const session = await provider.createSession({ sessionId: 'local-id', cwd: '/workspace' });
for await (const observation of session.observe()) {
  // Feed normalized observations to the existing Session View.
}
```

Each provider multiplexes one global SSE connection. Sessions declare shared control. Closing a session or provider only detaches local observation; explicit `cancel()` calls the native interrupt endpoint. A disconnected stream changes connection state and triggers authoritative reconciliation, without completing or failing the native turn. POST requests are never automatically replayed, including uncertain timeouts.

The adapter normalizes native text, reasoning, tools/results, compaction, usage, interactions, and runtime status. Session token totals come from native session aggregates; context usage comes from the latest useful model step and capacity from the native model catalog. It does not invent totals from a bounded history window. It reads the latest 200 native messages initially and supports older timeline pages. Native message IDs and content indexes drive live deltas; corrected history uses complete timeline replacements. Reconciliation buffers change notifications and refreshes again when needed to avoid replaying deltas already included in a snapshot.

Model, agent, model-specific variant, and permission selections persist in the native session and synchronize across clients. They can change during a running turn without aborting it; model and agent selections apply to subsequent native execution steps and are published only after native session readback. The default variant selection remains a UI sentinel that is never sent to the native API; native `default` means the model without a variant overlay. Variants retain their native meaning rather than being presented as universal Codex reasoning effort. Native skills, commands and manual compaction use the server catalog and APIs.

Input admission and execution use the native durable inbox. `steer()` admits a follow-up during model or tool execution without aborting the active step. Acknowledgement proves admission, not model execution; input is shown as materialized only with native message evidence. Native prompt editing forks before a validated user message; it never reverts the original workspace. See [native boundaries](../../docs/opencode-native-boundaries.md) for restart, pagination and prepared-input evidence semantics.

Handoff/native prepared-input evidence is explicitly unavailable for the current 2.x adapter. Default native message history cannot prove historical system instructions, and the experimental event log is not persisted by default. Ordinary lost acknowledgements can settle from exact input content followed immediately by an assistant in native sequence; this narrower fact does not certify the prepared-input contract.

Custom Host callback tools and dynamic Ask source reads require explicit installation of the bundled native plugin directory. It registers the two callback tools directly through the OpenCode 2.x tool interface. Callbacks use trusted native session context and private authenticated loopback HTTP; ordinary MCP arguments are not authorization. See [callback setup](../../docs/opencode-callbacks.md). Unconfigured servers remain usable for ordinary sessions.

Image input is validated against the shared Provider SDK limits, file type and digest, then sent inline. Resource reads expose bounded native inline images and native local output files through validated locators when using a loopback server; arbitrary filesystem paths and HTTP attachment URLs are not fetched. Shell metadata and native diffs use the existing normalized tool-result representation.

Server URL and HTTP Basic password are local constructor options; native authentication uses username `opencode`. Credentials never enter persistence handles or normalized observations. Shared native servers own their execution and permission policy; `restrictedNative: true` fails closed because the Host cannot impose a sandbox on another process. Explicit tool approvals and native forms are supported when the server is trusted.
