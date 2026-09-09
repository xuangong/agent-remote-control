# Normalized Interaction Capabilities

The workbench needs complete user-facing interaction semantics across native providers. Paseo is a behavioral reference, not a protocol or implementation dependency. Keep Provider interpretation, public types, Relay recovery, and UI separate. The user authorized implementing the missing capabilities after comparison.

## Evidence and decisions

Paseo's Codex adapter normalizes messages, reasoning, tools, questions, and plan review. Its MCP handler declines URL forms and forms with required fields, and wraps remaining forms in a generic permission request. Our SDK and public schemas already distinguish questions, plan review, and tool approval; retain that stronger boundary. Use explicit form, permission approval, and external action contracts instead of provider-shaped open metadata. No arbitrary schema execution or provider-specific renderer branches.

Existing canonical event families cover user/assistant/reasoning, tool lifecycle/results, usage, turns, and interaction request/resolution. Shared timeline/replay is retained. Native unsupported content must remain diagnosable; do not silently classify everything as an assistant message. Tool results stay bounded completed snapshots; live output streaming, terminals, file transfer, voice, and subagent orchestration are outside this interaction change.

## Shared contract

Protocol version becomes 1.3.0. Existing interaction shapes remain valid. Add optional `sensitive` to AgentQuestion and optional `redacted` to AgentQuestionAnswer. Actual answers travel only on the response command to the Provider; resolution, history, debugger records, and public traces must redact sensitive answers. Do not persist sensitive drafts in browser storage.

Tool approvals retain allowedDecisions/allowScopes. Extend decisions with `cancel`; scope with `policy`. Optional `policies: {policyId, description}[]` identifies provider-owned policy decisions, and optional `context: {label, value}[]` describes requested permissions. Allow response scope once/session remains unchanged; policy scope requires policyId. Native available decisions determine exactly which controls exist. No inferred or automatic grants.

New request kinds:

- `form`: requestId, title, message, fields. Each field has fieldId, label, required, optional description/sensitive; discriminated type text (minLength/maxLength/format/defaultValue), number (integer/minimum/maximum/defaultValue), boolean (defaultValue), select (options/defaultValue), multiselect (options/minItems/maxItems/defaultValue). Options have value/label. Formats: email, uri, date, date-time. Values are string, finite number, boolean, or string[]. Responses: submit with values, or decline/cancel. Optional redactedFields marks omitted sensitive historical values. Only a bounded, lossless supported subset of native form schema is normalized; unsupported schemas produce an explicit unavailable diagnostic and native decline rather than a partial form.
- `permission_approval`: requestId, summary, permissions ({resource: filesystem|network, access: read|write|deny|connect, target: string}[]), allowScopes (turn|session[]). Response: allow with selected scope, or deny. Grants apply to the whole precisely displayed request. Native permission objects stay inside the adapter; responses cannot inject broader grants.
- `external_action`: requestId, title, message, url. Responses: completed, decline, cancel. Only explicit HTTP(S) links are renderable. Opening a link does not itself acknowledge completion; no automatic navigation or third-party request.

Expose optional form, permissionApproval, externalAction interaction capability booleans; absent is unsupported. Implement shared request-aware validation and redaction in the SDK, with structurally equivalent protocol schemas. All interactions retain requestId correlation, one accepted responder, failed-submission retry, canceled lifecycle, and completed receipts.

## Provider behavior

Codex registers MCP elicitation and permission approval RPC handlers. Native JSON schemas are normalized to bounded typed fields; raw request data and policy decisions remain in pending native state. Mapping is reversible without interpreting display labels. Preserve sensitive markers. Respect availableDecisions including cancel and proposed amendments. Validate thread correlation. Enable only implemented capabilities. Resolve cancellation without fabricating user answers or emitting secrets. Keep meaningful known status events from becoming agent errors.

DSH retains native question/approval service ownership and competing local/remote responder behavior. Shared secret handling and additional union variants must not loosen DSH's supported scopes or invent unsupported capabilities. Report unsupported native form capabilities honestly.

Browser reconnect can recover pending interactions while the native process lives. Native process restart is a distinct boundary: do not resurrect obsolete RPC requests. Codex plan review, which we synthesize rather than receive as RPC, needs truthful recovery semantics. Persist only non-secret state required to distinguish reviewed plans if durable recovery is implemented; otherwise expose the limitation explicitly and do not claim parity.

## Acceptance

Behavioral tests cover schema rejection, request-aware validation, exact native responses, form constraints, sensitive redaction, scopes and cancellation. Test real HTTP/WebSocket transport, competing responders, history and reconnect. Exercise rendered forms and controls in desktop/mobile browsers with actual Codex app-server plus a deterministic local provider backend where feasible. Preserve existing live environments; use free ports. Full tests/build/typecheck and compatibility checks pass before local fast-forward integration. No push or publication.
