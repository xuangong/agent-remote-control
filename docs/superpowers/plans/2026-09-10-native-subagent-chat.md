# Native subagent chat implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Implement and review each owned layer, then verify the complete flow.

**Goal:** Show native Codex children below their originating parent reply, in creation/discovery order, and open their existing live chat with truthful native controls.

**Architecture:** A Codex runtime owns one app-server transport and routes threads to independent AgentSession instances. Child descriptors are a bounded session relationship summary in existing runtime_updated/Snapshot rails. Child chats reuse existing Remote session attachment, timeline, resources, interactions and controls. The directory authorizes child attachment through a loaded parent, without starting a second runtime. No Remote scheduler or invented native lifecycle operations.

**Tech stack:** TypeScript, Node, React, Vitest, Playwright, Codex CLI 0.148.0.

## Contract

Add exported SDK and public schema `AgentChildSession` with fields:

```ts
interface AgentChildSession {
  nativeSessionId: string;
  title: string;
  role?: string;
  description?: string;
  createdAt: string;
  parentTurnId?: string;
  parentCallId?: string;
  status: 'starting' | 'idle' | 'running' | 'waiting' | 'failed' | 'closed';
  observation: 'live' | 'saved_history';
}
```

`AgentRuntimeInfo.childSessions?: AgentChildSession[]` lists direct native children only. Absence means unavailable/not supported; an empty list means no discovered children. Origin call/turn is stable and established only from creation evidence; later send/wait calls do not reparent a child. Unknown origins render at conversation level. Descriptor status is native status, never inferred from a completed spawn call. Child identity is scoped by host/provider/native ID. `createdAt` retains first native creation or discovery time.

Codex provider exposes `openChildSession(parentNativeSessionId: string, childNativeSessionId: string): Promise<AgentSession>` and reuses the parent's original runtime. Each child session exposes the same method through an internal native implementation for nested children. Public SDK session interface need not expose Codex-specific operations. Provider runtime handles eager child request reception independent of page visibility; existing interaction rails become observable when a child attaches. Parent descriptor reflects waiting state.

Local directory route `POST /v1/remote/child/attach` accepts providerId, parentNativeSessionId, nativeSessionId; it resolves the authoritative direct-child relationship from the loaded parent source and deduplicates attachment. Ordinary root catalog continues excluding children. Source interface optionally implements openChild(parentNativeSessionId, nativeSessionId). Host sources without this ability report unsupported; no synthetic controls.

## Work units

- [x] Contracts and relay: add strict descriptor schema, carry it through runtime snapshots, refresh capabilities from native session on runtime_updated. Test invalid descriptors and snapshot/replay behavior.
- [x] Codex runtime: split transport ownership/thread routing, eagerly register native children, buffer early events, route original requests, preserve creation origin, open existing child sessions, reject unavailable or foreign children. Use thread/read for history; no resume is needed for child subscription. Never resume an unloaded child merely to view it. Test parent/child interleaving, late discovery, child approvals before opening, restricted input, duplicate open and release safety.
- [x] Directory: implement parent-authorized child attachment with deduplication and existing relay lifecycle. Test real HTTP attachment and unavailable/foreign parents.
- [x] UI: add a reusable child list to AgentTimeline below the last assistant message of its originating turn; unknown-origin list appears separately. Preserve creation order and expose waiting status. Lab switches chats through child attach and keeps drafts/navigation state. Use existing composer/capabilities. Test no duplicate rows across streamed chunks, source association, switching and failure retention.
- [x] Verification: baseline build/unit suite, focused runtime/contract/UI suites, full typecheck/build/unit/conformance/compatibility/docs, actual Codex spawn and browser switch with current gateway config on separate free ports. Record native limitations honestly.

## Constraints and review rulings

Only edit `.worktrees/native-subagent-chat`. Preserve chat-session-controls and its local services. Dependencies use Tencent npm mirror without global configuration changes. Root test scripts enforce process and runner deadlines. Existing unpublished 1.4.0 contracts are synchronized with compatibility fixtures after additive schema review. Do not merge the old subagent branch wholesale because it carries unrelated older interaction protocol changes. DSH child control is not invented: this delivery targets the user's Codex subagent flow while shared rendering and schema remain provider-neutral.

Saved children with persisted turns open read-only via `thread/read`; unloaded ephemeral children without history return an explicit unavailable error. Native reactivation restores live capability state. Unknown child model/permission values remain unknown, and Planning waits for a known model. The directory-backed Resume action reuses its existing native attachment. Ambiguous parent-child ownership across directly resumed duplicate runtimes is rejected.
