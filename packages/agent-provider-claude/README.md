# Claude Code Provider

`ClaudeAgentProvider` adapts Claude Code to the provider-neutral Agent SDK. It uses `@anthropic-ai/claude-agent-sdk` 0.3.247; the native validation target is Claude Code 2.1.247. Agent Host owns each persistent streaming-input Query and reuses it across browser and uplink reconnections.

```typescript
import { ClaudeAgentProvider } from '@borgee/agent-provider-claude';

const provider = new ClaudeAgentProvider({ executable: '/absolute/path/to/claude' });
const session = await provider.createSession({ sessionId: 'caller-proposal', cwd: '/workspace' });
// runtimeInfo().sessionId is the UUID accepted by the native runtime.
// Consume observe() continuously, including permission requests, before sending work.
```

## Contract

- Create initializes a Query without sending a model prompt. A new empty session remains process-local until native transcript persistence occurs.
- Discovery and resume use official SDK catalog/history functions in a helper process. Its environment carries the same `CLAUDE_CONFIG_DIR` as the Query; the parent environment is never mutated.
- Normal operation loads native user, project, and local settings and the Claude Code system prompt. Credentials remain in native configuration or the inherited environment.
- Observations contain saved messages before a single history boundary, followed by live text/reasoning deltas, tool calls/results, usage, compaction, interactions, and turn outcomes.
- Tool approval and `AskUserQuestion` callbacks await validated Remote answers. Only one-time tool approvals are advertised. Native rules that allow or deny a tool without prompting remain authoritative.
- Cancel interrupts the current turn and retains the Query. Dispose ends input and closes the Query. Native failure requires explicitly resuming the saved session; uncertain messages are never resent automatically.
- Idle model and permission settings call public Query methods and publish confirmed state. Planning restores the selected permission mode. An actual `ExitPlanMode.plan` becomes typed plan review; approval waits for native permission confirmation before execution.

## Skills and native children

The existing command protocol exposes skills discovered from the running Query. Discovery reloads native skills, validates/deduplicates the SDK command list, and execution revalidates opaque IDs before submitting the native slash invocation with unchanged arguments. Known unsupported session controls are excluded; compact remains a native command. The flat SDK list does not carry reliable filesystem provenance, so no documentation resource locator is invented.

Direct native agent tasks populate `runtimeInfo.childSessions`. Their IDs are scoped by the parent native session, with task/tool aliases retained across turns. `openChildSession(parentId, childId)` borrows a read-only view of the root Query. Child text, reasoning and tools have their own Timeline. Native lifecycle events control status; parent turn completion ends only foreground observation. Background tasks remain live until a native terminal signal or root shutdown. Closing a view never stops native work.

The isolated catalog helper uses official `listSubagents` and `getSubagentMessages` APIs for persisted children, excluding descendants identified by `parent_agent_id`. Saved history opens without launching a native child Query. Concurrent resumes of one native parent are rejected while loading or loaded; disposal releases ownership.

A first attachment after persistence receives canonical transcript order. An already observed child remains an append-only live projection: persistence can supply later content but does not insert missed earlier prompts/tools behind the answer. Navigation and re-pair preserve that projection; a fresh Host attachment can read complete saved history. Native message and content-block identities reconcile pending streamed tails and suppress delayed deltas already covered by saved blocks. Missing terminal/background transcripts remain unavailable until the native store is readable; attachment retries read the native store again. Child approvals are answered through the owning parent, and independent child input/cancel is not advertised.

## Limits

No direct child controls, live effort setting, steering, or follow-up queue is advertised. Native priority input can outlive the target turn and survive public interruption. MCP forms remain disabled because the pinned native client strips constraints and sensitive markers before its public callback. Nested agent messages are not inserted into the root transcript; their parent tool call/result remains visible. Tool results retain bounded text and native JSON with unambiguous tool ownership. Per-turn native tokens and Query cost increments are mapped separately from exact-model context metadata; `/context` provides actual native occupancy when available. Pending permission callbacks cannot survive Host restart. Catalog discovery describes persisted sessions, not attachment to an already-running Claude terminal process.

Root sessions expose bounded native tool-result embedded PNG/JPEG/GIF/WebP images through immutable session-owned resources. Limits: 16 MiB per image, 64 MiB per session and 1,024 images. Native transcript resume reconstructs available embedded bytes; disposal revokes reads. No arbitrary paths, remote URLs, uploads or child image-resource access.

## Verification

Run `pnpm build` before tests: the native integration suite exercises the built adapter and its catalog helper. Unit tests cover native event projection, permissions, lifecycle, and catalog mapping. `provider.local.test.ts` runs a real Claude Code binary with an isolated configuration root/workspace and a deterministic loopback Messages endpoint, covering multi-turn streaming, approved file writes, catalog/history/resume, and interruption. Set `AGENT_CLAUDE_TEST_EXECUTABLE` to select that test binary. This verifies native process integration without testing a live model service.

See [Host installation and debugging](../../docs/runbooks/claude-debug.md). Native API references: [Claude Code programmatic use](https://code.claude.com/docs/en/headless) and [official Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). The SDK package retains its own license and terms.
