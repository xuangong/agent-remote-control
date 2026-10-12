# Explicit TPM delegation and quiet background reviews

## Contract

- New TPM work starts in manual mode. Existing records retain automatic follow-up.
- Delegation belongs to the Host work record, independently of open windows, tabs, or devices.
- Manual mode permits normal conversation, todo decisions, work updates, and authorized main-session messages. It disables periodic and main-activity-triggered reviews.
- Stopping delegation cancels only undispatched automatic reviews. An accepted turn finishes normally; existing unknown deliveries retain their recovery requirements.
- User-triggered onboarding and todo decisions may cause a single response without enabling delegation.
- Paused/archived/completed work retains its stronger existing execution restrictions.
- Background inputs have durable Host provenance. Native records remain intact; public rendering can group maintenance activity without parsing TPM prose.
- A review result distinguishes a silent assessment from a user-visible update. Missing results, failures, human input, pending interactions, and substantive output must remain recoverable and visible.
- Presentation filtering does not promise to prune native model context.

## Implementation sequence

1. Separate work admission from automatic wake admission; add a persistent delegation control and manual-by-default creation. Verify existing work migration, manual tools, stop/start races, and current-turn completion.
2. Record background input identity and structured review outcomes; carry trusted annotations through shared history/live/replay paths. Shorten recurring prompts while retaining stable role instructions.
3. Group background records in the shared Session View and suppress quiet-only attention. Preserve search disclosure, errors, interactions, and ordinary user/assistant messages.
4. Verify Host behavior, protocol encoding/projection, browser controls, compatibility metadata, and builds. No deployment or Controller restart without a release request.

## Verification

Use per-test and outer deadlines. Exercise real transport for metadata delivery and reconnection. Preserve user services and native sessions. Existing unannotated history remains visible unless it can be associated with a retained authoritative Host record; never hide arbitrary matching text.

## Implementation and validation result

Implemented persistent delegation, manual-by-default creation, legacy automatic work migration, canceled undispatched reviews, bounded durable review provenance, explicit outcome events, shared timeline grouping, and quiet attention suppression. Resume/reopen preserve delegation instead of silently enabling automation.

Review fixes cover accepted checks that outlive delegation, lifecycle-only failure/cancellation, human steers, later ordinary turns, historical outcomes, and delayed history pages. Historical metadata corrects rendering without claiming current runtime activity. No native message text is rewritten or deleted.

Validation includes Host coordinator and real uplink tests, real WebSocket activity/reconnect tests, protocol codec tests, replica and shared renderer tests, ARDB recording and backwards replay, application tests, package builds/typechecks, and compatibility update/check. Desktop and mobile Chromium/WebKit delegation/grouping browser cases passed (8 cases). Native CLI end-to-end model behavior was not exercised; transport fixtures use normalized fake providers. Existing unregistered heartbeat history remains ordinary content.

Implementation validation completed before release authorization. Deployment requires an updated Controller for the Host delegation/provenance behavior; native model behavior remains a separate acceptance boundary.
