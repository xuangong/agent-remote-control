# Content-only reply presence

Status: requested behavior, with a component treatment proposed for review. No product implementation or deployment yet.

The user wants Content only to feel like an IM conversation: while the Bot responds, show an ellipsis-like speaking/typing state. This is a targeted addition within the protected Session View, not authorization to redesign messages, tool rendering, approvals, headings or the composer. It applies to Content only in either Bot or Window mode.

## IM references and adaptation

- [Signal's typing indicators](https://support.signal.org/hc/en-us/articles/360020798451-Typing-Indicators) use animated dots to communicate typing. Adopt the quiet, recognizable visual convention.
- [Telegram's bot chat actions](https://core.telegram.org/bots/api#sendchataction) communicate temporary ongoing activity separately from a message. Adopt the distinction between transient presence and persisted conversation content. Telegram's expiry and clearing rules are specific to its protocol; do not copy them as a timeout for an agent turn.

Both official pages were fetched directly on 2026-11-13. Public documentation was reviewed; no authenticated IM sessions were tested.

## Proposed treatment

- Render one restrained three-dot indicator on the assistant side at the live end of the conversation, after the latest visible content. During a response it stays separate from Markdown and code so incoming text never moves the indicator between paragraphs.
- Use three small dots with a staggered opacity cycle. Keep their footprint fixed while present. No bouncing, new avatar, message bubble redesign, loading skeleton or repeated per-message indicator.
- The dots mean **responding**, including hidden reasoning or tool work in the active response. They do not assert literal keystrokes or uninterrupted token generation. Keep the existing detailed activity and interrupt controls authoritative.
- Remove the indicator when the active response ends, stops, fails, waits for user input, or becomes disconnected/unsynchronized. A queued send or optimistic local message alone is not evidence that the Bot is responding.
- Do not show it for saved history, replay or a hidden/offscreen conversation. Re-show only from current synchronized state. Mere elapsed time must never imply completion or fabricate a live state.
- Preserve existing scroll behavior. Do not pull a reader away from older content, remount the timeline, or repeatedly announce animated dots to screen readers. Use a single state-change announcement such as `Agent is responding`; reduced-motion users see static dots.
- Session role tags remain independent identity metadata. A `TPM` tag does not turn into a typing label or change with runtime activity.

## Current implementation evidence

`RemoteSessionState` in `agent-remote-web/src/client/session-state.ts` exposes activity, synchronization and runtime connection. Existing `AgentActivityStatus.tsx` already distinguishes working, waiting, unavailable and terminal conditions. `SessionWorkbench.tsx` controls the display mode and connection presentation, and `AgentTimeline.tsx` applies Content only filtering.

The common `assistant_message` schema in `agent-remote-protocol/src/timeline.ts` has text and optional message identity, but no universal per-message typing/stream-completion flag. Therefore do not infer a provider-native output phase from message text or a recent timestamp. Exact product wiring must reuse authoritative session facts and inspect pending interactions, active turn, read-only history/replay and lifecycle boundaries before implementation. This visual addition should not need a new native interpretation in the renderer.

## Review artifact and implementation acceptance

[Interactive component study](../../design-previews/2026-11-13-reply-indicator-review.html) shows responding, complete, waiting, failed, reconnecting and saved-history states, with a mode switch. Its mock state controls and frame are not product UI and provide no live-provider evidence.

The standalone study passed headless Chromium checks at 900px light, 390px light and 320px dark widths with no horizontal overflow or page errors. All six simulated states, display-mode gating and static reduced-motion dots were checked; phone and narrow-dark screenshots were visually inspected. Evidence is retained in `.tmp/ui-modern-3a/reply-indicator-check.log` and `reply-indicator-*.png`. This verifies the study only.

For eventual implementation, verify active response start/end, streaming plus hidden tool execution, waiting requests, cancel/failure, reconnect and history replay. Also verify Content only versus other modes, both workbench modes, phone/desktop, reduced motion, draft retention and reading older history. Real local-instance acceptance remains required; no acceptance result is claimed by this design document.
