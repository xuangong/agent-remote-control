# Paseo event and interaction comparison

This audit compares the local Paseo checkout at `463415a` with Agent Remote Control. Codex behavior is checked against CLI `0.148.0` and its generated app-server types. Paseo is source evidence, not a runtime dependency or an implementation template. Paths in the Paseo column are relative to that checkout; line references describe the audited revision.

## Capability mapping

| Capability | Paseo evidence | Agent Remote Control implementation |
| --- | --- | --- |
| Messages, reasoning, tasks, turns, usage | `packages/server/src/server/agent/providers/codex-app-server-agent.ts`, `threadItemToTimeline` | Existing canonical SDK event families and shared Timeline remain the foundation. Native bookkeeping has no independent conversation row. |
| Tool use and result | Same adapter's `mapCodexToolCallFromThreadItem`; `packages/app/src/components/tool-call-details.tsx` | Existing callId-linked bounded text/JSON results cover commands, MCP, file changes, and search. UI reads canonical fields; it does not decode native payloads. Output streaming remains separate work. |
| Questions and plan review | Adapter permission handlers and plan synthesis around lines 3663–3704 | Retain explicit question IDs, structured answers, and plan decisions. Sensitive answers are transient commands; completed receipts are redacted. Synthesized pending plan state remains process-local. |
| MCP form and URL elicitation | `handleMcpElicitationRequest`, lines 6734–6778, declines URL and required-field forms and wraps optional forms in generic permission metadata | Add distinct typed `form` and `external_action` contracts. Normalize supported schemas losslessly; explicitly decline unsupported ones. Opening a link and confirming completion are separate actions. |
| Filesystem/network and tool policy approval | Codex request registration and native approval handlers in the same adapter | Preserve exact grants in the Provider closure. Public permission entries describe scope; tool policies use stable IDs. Buttons follow native allowed choices without inventing broader authorization. |
| Native image output | `mapCodexThreadImageItem`, lines 1820–1859 | Reuse Assistant Markdown and the existing resource pipeline. Opaque references resolve only native session-owned image items, with bounded raster data and no URL fetching. |
| Subagent activity | Native child-thread routing and `provider_subagent` mapping around lines 5221 and 5567 | Normalize parent tool lifecycle/results. Child discovery, navigation, and orchestration need their own product contract and are not copied into this change. |
| Skills | Skill discovery and input mapping around lines 4760 and 3929 | A skill catalog/selector is an input capability, not a missing Timeline event. Native skill use continues through Codex; the workbench does not claim a catalog or loading receipt absent native evidence. |

## Ownership and recovery

The implementation keeps one direction of interpretation: native Provider → SDK semantic event → Relay validation and projection → versioned public protocol → Web replica → shared renderer. Responses follow the inverse path using stable request and field IDs. Relay owns transport ordering and one accepted responder, not native schema interpretation. Provider closures own original RPC IDs, exact grant objects, and policy values; React never consults Provider-native JSON.

Version `1.3.0` remains exactly negotiated. DSH exposes only its native question, plan, and tool services; extending the common union does not claim new DSH capabilities. Browser reconnect recovers pending requests while the Host lives. Native restart is different: obsolete RPCs must not reopen, completed typed receipts are not reconstructed from native logs, and synthesized plan approvals are not inferred from the last historical plan.

## Validation boundaries

- SDK and strict wire tests cover typed fields, constraints, choices, redaction markers, and response validity.
- Scripted Codex app-server tests assert exact native responses for elicitation, grants, policies, cancellation, and thread correlation. A separate pinned real CLI test checks process and transport behavior with a local Responses backend.
- Actual local HTTP/WebSocket tests cover concurrent responders, failed submission and retry, pending recovery, secret-free history, and native image bytes across reconnect.
- Browser tests use a deterministic Provider through the actual workbench, Relay, and transports on desktop and mobile. They cover form controls, permission durations, explicit link completion, policy choice, redacted history, and pending recovery. This fixture does not prove a live model will emit each native request.

Tool-output streaming, interactive terminals, generic file transfer, dedicated diff/search visualizations, a skill selector, and child-session orchestration remain separate capabilities. None is implied by displaying the underlying result JSON or passive subagent tool summary.
