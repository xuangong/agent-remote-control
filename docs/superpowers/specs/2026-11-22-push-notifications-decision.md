# Push notifications: decision proposal

Status: proposal for the owner, 2026-11-22. Not implemented. It answers matrix row 8.4 and the push part of gap 7 of the [requirements review](2026-11-21-requirements-vs-external-dependencies.md), and IM gateway decision 3 ("notifications with no page open"), which waited for the read state and presence. Both exist now: shared read positions, the outbox, and the Relay's knowledge of which sessions a visible page shows (`journal_shown`, intent reports).

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
- **Service worker.** Push and `notificationclick` only: a click opens the conversation's address, or focuses a page that already shows it. It caches nothing, so the immutable asset policy and the chunk recovery stay as they are.
- **Badge.** The unread count of the read positions, set by the service worker on each push and by the page on each read.

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
