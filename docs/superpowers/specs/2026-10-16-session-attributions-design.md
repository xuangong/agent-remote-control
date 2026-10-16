# Session attributions

## Purpose

A session describes its relationships independently of the Window or pane displaying it. Ask, Side, TPM, Team and native child sessions use one read-only description and one attribution renderer. The product keeps the existing simple title by default. An explicit disclosure expands a compact, borderless property table below the title, in normal layout flow.

## Ownership

- Native parent/child evidence comes from provider-normalized metadata.
- Ask and Side use their existing source records and navigation overlays.
- TPM uses its current main reference; Team uses its source and member roster.
- A public browser description contains identity and typed attribution rows. It does not own or persist a second relationship graph.
- The product projects existing records into the description. Session View consumes the description and emits navigation requests. Window decides which pane presents a destination.
- Closing a view, binding another session, docking or reordering does not change business relationships, native execution, source-read permissions or archive state.

## Public description

`SessionDescription` has an identity (`hostId`, `providerId`, `nativeSessionId`) and an ordered attribution collection. Each attribution has a stable ID, semantic kind, display label, value, optional explanatory detail and optional target. A target is either a session identity or an application group identity. Unknown kinds can still display using their label and value. Targets do not confer authorization.

The browser package exposes this contract without dependencies on Lab, account state, TPM or Team. Native ancestry is not inferred from pane adjacency, `attachedTo`, `closeWith`, matching titles or a business main relationship.

## Projection rules

- Ask: Role and Main; distinct original context source when different from current main.
- Side/reference fork: Role and Source; distinguish original context source from current navigation source after a confirmed handoff.
- Snapshot fork: Source plus snapshot context information, without claiming native fork ancestry.
- TPM: Role and current Main. A followed role may expose a distinct Role origin, which is not evidence of the TPM reader's original context source. Fixed references navigate to their exact historical session.
- Team leader: Role, Team and Main.
- Team member: Role, Team, Leader and Main. Membership never implies inherited leader history. An already identified managed member retains its known relationships when its execution locator is unavailable; unknown destinations remain plain text.
- Native child: Parent when supported by directory or runtime evidence.
- Sessions with several known relationships retain them rather than selecting one arbitrary parent.
- Resolve labels from known identities, including host identity. Unknown titles fall back to the native session ID. Do not guess a relationship when metadata is absent.

## Presentation

The default title, centering, rename behavior and control placement remain familiar. A separate chevron has the accessible name `Show session attributions` / `Hide session attributions`. The expanded region is a semantic property table, with muted row labels and readable values. Session or group targets are keyboard-operable links/actions. There are no grid lines, cards, tag backgrounds or overlay panels.

Only an explicit expansion consumes additional header height. Rows wrap within the value column on narrow views, and the region has a bounded height with internal scrolling for unusually large descriptions. Long values remain inspectable. Empty descriptions do not add an empty panel. Each rendered view controls disclosure independently; the relationship data is shared by session. Dock/undock must not remount the conversation. No new saved Window fields or wire schemas are required.

The same primitive supports inline headings and containers with an existing external heading, including TPM and the main mobile/toolbar presentation. Before a TPM work has a native Session identity, its work shell retains the existing Main action without inventing a Session description. Standalone consumers can supply a description directly without product services. Existing relation management actions remain with their business module.

## Navigation

Match by full session identity, never title. In the active Window, select an existing matching pane and let the existing layout reveal it. A stale pane whose binding changed is not a match. Fixed or original sources carry an explicit historical navigation intent and do not reuse panes that follow the current role. If the destination is absent, wide layouts open an ordinary pane without overwriting unrelated docks; compact layouts present the destination in the foreground. A group target uses its owning module's navigation. Navigation completes when the local Window accepts and presents its layout change; background persistence uses the existing Window save feedback and never holds a relationship button pending. Navigation failures are shown inline in the attribution region, without discarding the chat, draft or relation.

## Validation

Cover identity across hosts, current versus original source, Ask source retention after pane replacement, native versus business relationships, Team leader/member differences and multiple relationships. Exercise the public renderer with independent views, keyboard disclosure, link failures, description updates and long text. Verify ordinary, Ask, Side, TPM, Team and native child integration. Use desktop and narrow browser layouts to check centering, overflow, collapsed height, absence of overlays and preserved conversation mounting. Run type checks, focused behavioral regressions, compatibility regeneration and verification. No deployment, package release or Controller update is included in this task.
