# OpenCode shared provider

## Scope

Integrate OpenCode into the existing Provider SDK, ARDB, Controller directory and product provider selection. Reuse the normalized Session View and public Remote protocol. Native interpretation stays in a new `agent-provider-opencode` package.

## Runtime ownership

Connect to an independently running `opencode serve` over the official SDK HTTP/SSE client. Default endpoint is `http://127.0.0.1:4096`; allow an explicit endpoint and HTTP Basic credentials through local configuration. Do not start, kill or upgrade a user's native server implicitly. CLI users attach to that same server. Controller detach, directory close and upgrade do not abort native work. Only explicit cancel calls native abort. Advertise shared session control, not stdio takeover.

## Native contract

Use the deployed server's established session/message and global-event endpoints, verifying against local OpenCode 1.18.18 and a pinned SDK. Do not assume the new durable Session v2 endpoints are mounted by `serve` merely because generated types exist. Use native session identity plus canonical working directory for resume. Titles are native, idempotent and use existing Host title broadcasts.

## Observations and controls

Support text, reasoning, tool states/results, todos, compaction, usage, status/errors, image inputs, permissions and questions, history and native model/agent selection where exposed. Only advertise implemented capabilities. Reject unsupported delivery or settings rather than silently changing their meaning. Initial history ends with a boundary; recovery reconciles authoritative history, runtime and pending interactions before consuming buffered live events. Stable message/part identity prevents duplicate output. Transport loss is connection state, not a terminal turn. Unknown send outcomes must never be automatically replayed.

## Host and security

Add provider selection and a shared native session directory with workspace checks. External server credentials remain local and never enter persistence handles, Remote events, browser configuration or recordings. Use explicit server URL configuration rather than accepting public wire input that can redirect local credentials. Session permission controls remain constrained by Host execution policy. Session selection by ID must validate native directory even when listing is incomplete.

## Verification

Test over an ephemeral real HTTP/SSE fixture: send/echo, history/live overlap, disconnect/reconnect, duplicate final parts, question and permission resolution, cancellation and dispose without abort. Verify Host directory create/open/rename and shared control. Run isolated native OpenCode smoke without using live user sessions. Exercise ARDB and package builds, type checks, focused tests and compatibility metadata. Do not merge, push, deploy or publish without a later request.
