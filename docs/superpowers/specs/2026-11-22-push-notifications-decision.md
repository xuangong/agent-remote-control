# Push notifications: decision proposal

Status: decided by the owner and implemented in I5c, 2026-11-22 (`docs/current/agent-remote/gateway-relay.md`, "Push reminders"; `lab.md`, "Push reminders"). The proposal as written follows. It answers matrix row 8.4 and the push part of gap 7 of the [requirements review](2026-11-21-requirements-vs-external-dependencies.md), and IM gateway decision 3 ("notifications with no page open"), which waited for the read state and presence. Both exist now: shared read positions, the outbox, and the Relay's knowledge of which sessions a visible page shows (`journal_shown`, intent reports).

## The problem

An assistant that needs the person (an approval, a question) or finishes a long turn says so only while a page of the account runs (`lab/src/session-notifications.ts`). iOS suspends a page in the background and ends it later, so on a phone the person learns it only when they open the app again. An approval can wait unseen for hours.

## What the platforms offer

- **Web Push** (Push API with a service worker and the Notifications API). Chromium and Firefox on every platform. On iOS and iPadOS since 16.4, **only for a web app added to the home screen**, and the permission must be asked from a tap.
- The push travels through the browser vendor's push service (Apple's `web.push.apple.com` for Safari). The sender signs each request with a VAPID key (RFC 8292) and encrypts the payload for the subscription (RFC 8291). Workers have the Web Crypto primitives for both (ECDH and ECDSA on P-256, AES-GCM, HKDF); no Node dependency is needed.
- A subscription can end at any time: the push service then answers 404 or 410, and the sender forgets it.
- The Badging API (`navigator.setAppBadge`) shows an unread count on the home-screen icon, from the page or the service worker.

## Options

| | What | For | Against |
|---|---|---|---|
| A | Web Push to the installed app and to desktop browsers, sent by the Relay | Reaches a phone whose page is suspended or ended; the Relay already knows session states, reads and visible pages; no third party beyond the browsers' push services | A service worker, VAPID keys as Worker secrets, payload encryption in the Worker, a subscription store per device, a permission flow. iPhone only when installed |
| B | A message through another IM (the IM gateway's other channels) | Works without installing anything | A third-party account and its credentials; content leaves our system; a second product surface |
| C | Keep in-page notifications only | Nothing to build | Row 8.4 stays false: an approval waits unseen on a phone |

## Recommendation: A, in one bounded step

- **What is sent.** Only the two reminders the page sends today, for a session the person can read: an assistant **needs you**, and a turn **finished while no page of the account showed it**. The payload carries the assistant's name and the reminder kind, never conversation text, so a push service never sees content.
- **Who decides.** The Relay, at the moment a session state changes (the same `session_states` it sends to pages). It sends nothing while a page of the account shows the session (`journal_shown`), so a person never gets the reminder twice. One reminder per session and state, collapsed by a tag, as the page's notifications are today.
- **Subscriptions.** Per device and per account, kept by the Relay with the account's state. Created from Settings with one tap ("Notify me on this device"), on the installed app or a desktop browser. A 404 or 410 from the push service forgets the subscription; sign-out and a revoked browser forget it too.
- **Service worker.** Push and `notificationclick`: a click opens the conversation's address, or focuses a page that already shows it. It joins the app shell worker of I5a, whose caching it leaves as it is.
- **Badge.** A dot, never a count (owner decision 4): `setAppBadge()` with no number, set by the service worker on each push and set or cleared by the page from the unread and needs-you state.

## How it would be tested

- The sender is a module with the push service as a port: a seam test with a fake push service checks the signed request, the encrypted payload (decrypted with the test's private key), the tag, and forgetting a subscription on 404 or 410.
- The Relay's decision (send, or not while a page shows the session) is a pure rule with a vector table, beside the session-state rules.
- The permission flow and the service worker's click routing are component tests; the lifecycle simulator's installed app and `kill()` give the "no page runs" state.
- Delivery itself depends on Apple's and Google's push services. It is checked by hand on a real iPhone (the installed app, locked) before the release, like the lifecycle check.

## Size and order

M to L: the sender and its encryption (S to M), the subscription store and routes (S), the service worker and Settings (S), the Relay's decision (S). It needs no Controller change and no change to the session wire. It is best placed after the provider boundary steps (B3 to B7), since it adds a new external dependency (the push services) that gets its own simulator first, as section 3 of the review asks.

## Questions for the owner

1. Ship Web Push (A) at all, given that on iPhone it works only for the installed app?
2. Are the two reminders the right set, or also "a message from an assistant" while away (closer to an IM, and more pushes)?
3. Is a payload without conversation text acceptable on the lock screen ("Chief needs you")?

## Owner decisions (2026-11-22)

1. **Web Push (option A).** The Relay sends it to desktop browsers and to the installed app. On iPhone only the installed app can receive it, which is Apple's rule and is accepted.
2. **Two reminders.** A push goes out when an assistant **needs you**, or when a turn **finished while no page showed it**. An ordinary assistant message sends no push.
3. **Name and kind only on the lock screen,** for example "Chief needs you" or "Builder finished". Conversation text never passes through a push service.
4. **The badge is a dot,** never a count, as the Orchard design says. Use `navigator.setAppBadge()` with no number. Correct "How it is done" here: the badge is a dot, not a count of read positions.

Before the sender is built, the push service gets its own simulator, per section 3 of the requirements review.

## As implemented (I5c)

- The push services got their simulator first (`@orchardworks/agent-remote-fixtures/push-service`), then the sender; seam S8 runs one against the other.
- "A page of the account shows the session" is a session-channel stream of the conversation in use (`journal_shown` counts the same content streams, for every account and whether or not the page is visible); the channel's intent reports narrow it to the account's visible pages.
- One push per session and state: each change the Relay sees is one state, so a second need in the same turn is pushed too. On screen and at the push service, a session's reminders collapse by its tag.
- The per-device setting the Relay respects is the device's own Notifications switch (`paused` on its subscription), beside group mute, chat mute and the group's needs-you-only choice.
- While push is on for a device, its page leaves the assistants' reminders to the Relay, so a desktop does not show them twice.
- Delivery through Apple's and Google's services is the real-device check of the release.

