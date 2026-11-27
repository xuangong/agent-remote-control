# Navigation stack of Bot mode
Module: `agent-remote-lab/src/features/chats/stack-transition.ts` (the motion's rules), `useNavigationStack.ts` (the phone's push, pop and edge swipe), `kept-conversations.ts` (the conversations kept under the one on screen) and `BotWorkspace.tsx` (which layer shows what); the reading position it relies on is `agent-client-web/src/react/useTimelineScroll.ts` with `timeline-entry-index.ts` and `agent-remote-lab/src/kernel/conversation-recovery.tsx` (`ReadingPositions`). Tests: `stack-transition.test.ts`, `kept-conversations.test.ts`, `timeline-entry-index.test.ts`, and the component specs `e2e/components/native-stack.spec.ts` and `assistant-phone.spec.ts`. Design source: step 3 of the fix plan of the native-experience audit (`docs/superpowers/reviews/2026-11-27-native-experience-audit.md`).

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 12 | 0 | 11 | 1 |

## Purpose
- N1. Going from the list into a conversation, into its details and back leaves every view under it as it was: the list's scroll, a kept conversation's open state, and the reader's line in each conversation. The installed app behaves as a native navigation stack does; it does not only look like one.

## Inputs and outputs
- N2. The reading position of a conversation is `following` (at the latest message) or an anchor (a row and its distance from the top of the timeline). It is kept per conversation, with the other recovery records of the device (`ReadingPositions`: session storage, and local storage on page hide, so a relaunched home-screen app finds it), and goes with the device's cache when the person chose to clear it on close.

## States and transitions
- N3. A conversation that was left comes back on the same row at the same offset: after the details, after another conversation, after Back, after the page reloaded. A conversation left at its latest message stays at it while messages arrive. (Tests: `native-stack.spec.ts`, the four reading tests.)
- N4. An entry of a turn the browser has not rendered (content-visibility) is never taken for the reader's line: its box is the turn's collapsed one. (Test: `timeline-entry-index.test.ts`; the reload test of `native-stack.spec.ts`, which put the reader three messages away before.)
- N5. Progress 0 is the list at home and 1 the conversation shown. One number places both layers: the conversation at `(1 - p)` of the width, the list shifted `-30 %` of the width times `p`, and a dimming layer between them at `0.6 p`. (Test: `stack-transition.test.ts`.)
- N6. On a phone a push and a pop keep both layers on screen until they end, with the same timing, from the motion tokens (`--orchard-duration-pop`, `--orchard-ease-standard`). A zero duration, from the system's reduced motion or the reader's own choice in Settings, settles at once and leaves no animation. A wide screen moves nothing. (Tests: `native-stack.spec.ts` push, pop, reduced motion, wide screen.)
- N7. An edge swipe starts on the strip along the conversation's left edge below the top bar (20 px, `touch-action: pan-y`, so the browser leaves horizontal movement to the page). It waits 8 px for a direction; a vertical or leftward start is the page's. It follows the finger with both layers. Released past 40 % of the width, or faster than 0.8 widths per second, it goes back (the page's Back, one history entry); otherwise the conversation returns. (Tests: `stack-transition.test.ts`, `native-stack.spec.ts` swipe specs, one with Chromium's real touch input.)
- N8. A touch the system takes over (`pointercancel`) returns the conversation, and a back within 800 ms of it is the system's own: the stack slides nothing of its own, so the system's gesture is not drawn twice. (Test: `native-stack.spec.ts`, the system's touch.)

## Limits
- N9. Three conversations stay mounted: the one on screen and the two before it, parked out of sight and detached from their session. Each holds its timeline's elements and its replica in memory, which a phone has least of, and the reader moves between a few conversations. One beyond the bound is released and opens again from its stored reading position (N3). (Tests: `kept-conversations.test.ts`, `native-stack.spec.ts`.) A conversation that cannot be described any more (its assistant removed or hidden) is released at once.
- N10. The list is kept apart from the browser: a browser may drop the scroll position of a list it stops displaying, so the list's own is kept and put back when it returns. (Test: `BotWorkspace.test.tsx`.)

## Errors and refusals
- N11. A conversation whose session is not attached yet shows the shape of a conversation with the newest reply the list knows as its last bubble, never a blank body; a Host that is away says so in words instead. (Tests: `ConversationTimeline.opening.test.tsx`, `AgentTimeline.unloaded.test.tsx`.)

## Guarantees
- N12. What iOS does with an edge swipe in a home-screen app is not tested here, only on a phone: iOS web views can draw their own back gesture from the left edge when the page has history entries (a conversation pushes one). If it does, the touch ends in `pointercancel` (N8) and the page's pop is not slid again. Confirm on a real iPhone that the strip's swipe and the system's never both play, and that vertical scrolling at the left edge still works.

| Clause | Test(s) that prove it |
|---|---|
| N1 to N3 | `native-stack.spec.ts`: back from the details and from another chat; a reload; a conversation left at its latest message |
| N2 | `conversation-recovery.test.ts` (relaunch from local storage, anchors per scope) |
| N4 | `timeline-entry-index.test.ts`; `native-stack.spec.ts` reload |
| N5 | `stack-transition.test.ts` |
| N6 | `native-stack.spec.ts` (phone push and pop, reduced motion, wide screen), `reduced-motion.spec.ts` |
| N7 | `stack-transition.test.ts` (`EdgeSwipe`, release rule), `native-stack.spec.ts`, `assistant-phone.spec.ts` |
| N8 | `native-stack.spec.ts` |
| N9 | `kept-conversations.test.ts`, `native-stack.spec.ts` |
| N10 | `BotWorkspace.test.tsx` |
| N11 | `ConversationTimeline.opening.test.tsx`, `AgentTimeline.unloaded.test.tsx` |
| N12 | not tested: needs a real iPhone (the audit's list of what only a device confirms) |
