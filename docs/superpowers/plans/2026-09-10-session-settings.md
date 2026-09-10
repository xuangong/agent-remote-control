# Session Settings Implementation Plan

**Goal:** Control native session models and permissions from chat commands and shared selectors.

**Architecture:** Providers publish `AgentSessionSetting[]` inside `runtimeInfo.settings`; existing snapshots and runtime updates deliver authoritative values and selectable options. One `set_session_setting` request carries `settingId` and `value`, with the existing command acknowledgement. Slash commands are client navigation, never native RPC names or model prompts.

**Constraints:** Preserve native semantics. Only connected, idle sessions without pending interactions can change settings. DSH model selection advertises its session-and-default scope. Native permissions remain validated by the runtime. Unknown values, read-only settings and unsupported providers fail explicitly. Protocol 1.4.0 is negotiated exactly because older strict schemas reject the new fields and request.

## Contract and transport

- [x] Add codec rejection/roundtrip and Relay sequencing tests, then implement `AgentSessionSetting { id, category, label, value, options, mutable, scope, description? }` and `AgentSession.setSessionSetting(id, value)`.
- [x] Route the typed request through the session wire and client. Validate choices against current Provider state; publish freshly read state before ACK. Keep planning on its existing operation.

## Native adapters

- [x] Codex: test `model/list`, native settings notifications and `thread/settings/update`, including rejection and external changes. Read native approval/sandbox constraints. Never update confirmed values from a submitted request.
- [x] DSH: test the public model catalog/controller selection and registered `/permission` command. Read current selection and permission services, preserve native default side effects in the descriptor, and publish session setting events through existing runtime updates.

## Chat controls

- [x] Test `/status`, `/model`, `/permissions`, `/help`, unknown commands, capability gating, pending updates and session switching.
- [x] Implement a shared settings panel and slash menu with keyboard selection. Keep drafts and mutations scoped to the session; expose current model and permissions in the composer.

## Acceptance

- [x] Build and synchronize compatibility; run unit tests with root suite deadlines, typecheck and docs lint.
- [x] Exercise model and permission changes through the real Codex process in desktop/mobile browser fixtures, then reload and verify native confirmed values.
