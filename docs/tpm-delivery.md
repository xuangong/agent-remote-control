# TPM delivery workspaces

A TPM is a normal agent session accountable for one agreed work item. It clarifies the user's need, maintains a plan and acceptance criteria, coordinates implementation with a bound main session, examines evidence, and reports back. It does not implement product code itself. A main session can serve multiple independent work items.

## Using the workspace

Use `/tpm` or the View menu to show or hide the global TPM entry. `/tpm on`, `/tpm off`, `/tpm enable`, and `/tpm disable` are also supported. Without an explicit saved preference it is visible on coarse-pointer/mobile devices and hidden on desktop, independently of Track.

Select a supported main session and choose **New TPM session** to open a conversation directly. No title or requirement form is needed. Unnamed sessions receive a color-and-flower placeholder such as **Amber Iris**. Click the title and pencil to rename at any time; user-chosen names are preserved by automated work updates. A vague intention is enough: use the conversation for research, requirements and solution design, then follow implementation through acceptance. The objective and plan can evolve as discussion makes them clearer. The TPM asks what the user wants and waits for their reply; it must not infer an assignment from main-session activity. Once discussion establishes the objective, it sets a concise work title through `update_work`. API callers can still supply an optional title and initial requirement. The catalog refreshes automatically, including when the menu opens or the window regains focus. Opening a work displays the ordinary Session View and full composer in an Ask-style workspace. Desktop workspaces can be resized; small screens use an overlay. Conversation is primary. **Plan & acceptance** opens the TPM-maintained Markdown document, which can remain empty while the need is still being clarified. The document is not automatically an approved specification.

Closing, minimizing, changing sessions, or hiding TPM view preserves drafts and does not stop automatic follow-up. The product does not expose heartbeat controls. Talk to the TPM to discuss progress or change direction. Work progress and native runtime status are separate facts. A main session finishing unrelated work never marks the TPM work complete.

Every conversation, including main, Side, Ask, and TPM, uses the ordinary Session View. TPM adds a workspace around it, not a separate chat renderer, reduced composer, or connection state machine. Timeline rendering, search, display preferences, model and permission controls, drafts, and recovery stay in the common view and client. The work list, progress assessment, and Plan & acceptance are outside that boundary; container size determines responsive presentation.

TPM composes the standard [session companions](session-companions.md): a sequential execution list, explicit user confirmation, and heartbeat. Open **Todo** inside the Session View to inspect the current step and remaining work. Confirmation shows the concrete proposal and provides **Agree** and **Needs changes**. The model cannot approve these steps itself. Chat remains available while a decision is pending; conversational discussion alone does not record approval.

The initial list covers clarification, plan agreement, implementation, verification, user acceptance and reporting. TPM can edit remaining steps at boundaries, while completed history stays intact. Revisions to an approved plan require fresh agreement. The expanded list overlays the current view without moving the timeline or composer.

Completed work can be archived from its workspace. Archiving retains conversation, documents and evidence, removes it from the active menu count, and places it in the collapsed **Archived** list. Open an archived work to view it or restore it. Restoring leaves the work completed; **Reopen** explicitly starts further follow-up and also removes the archive marker. Unfinished work cannot be archived.

## Background behavior

The Controller keeps records beneath its state directory in `tpm-v1`. It holds background session leases and subscribes to the existing shared managers. It never calls native `observe()` a second time. Same-Controller coordination continues without a browser or Relay connection; the machine and model endpoint must still be available.

Committed main-session content and relevant waiting/failure/completion boundaries request a coalesced review. Token streaming, usage updates, and history pagination do not independently trigger reviews. The initial defaults are a five-minute heartbeat, thirty minutes while waiting for the user, a two-second event window, a thirty-second minimum automatic review interval, and two concurrent automatic reviews per Controller. Busy TPMs are not interrupted. Main-session messages use native next-turn delivery when available, otherwise remain in a Controller queue until ordinary input is admissible.

TPM instructions require an explicit work-state update after each review. A review receipt alone does not mean that work progressed. Overdue accepted reviews with no assessment are checked using a new reflection after the native session is confirmed idle. The old input is never replayed.

## Bound tools and authority

Tools can only access this work and its bound main session:

- `read_work`: current requirement, assessment, pending intents, plan, and document versions.
- `read_main_session`: authoritative state and bounded, paginated history; search is explicitly limited to the returned page.
- `send_main_message`: persist a current-step consultation, implementation request, or acceptance feedback without interruption; recheck the step and applicable user approval before native dispatch.
- `update_work`: revision-checked assessment and optional work title; completion requires every todo step, acceptance criteria and evidence.
- `write_work_document`: update the work document and retain bounded document versions.
- `schedule_check`: request an earlier review within Controller limits.
- `read_todo_list`, `revise_todo_list`, `update_todo_step`, `complete_todo_step`, `request_todo_confirmation`: the standard sequential list toolkit. These do not expose a user-approval operation to the model.

Role instructions are appended to native instructions. Existing provider permissions and workspace policy remain authoritative. Prohibiting implementation in the role prompt is a behavioral constraint, not an additional sandbox or proof that native filesystem tools are disabled.

## Recovery and diagnostics

Intent is written before native dispatch. Receipts distinguish acceptance from completion, retaining native `started`, `queued`, or `handled` when supplied. A crash after dispatch and before receipt persistence becomes an unknown outcome. It is not retried automatically, even using the previous operation ID: the common operation cache remains process-local.

Unknown creation can be explicitly abandoned or bound to a verified, distinct recovered native session. A session already serving as a main or another TPM cannot be rebound. Native CLI takeover pauses affected automation; the Controller never silently takes it back.

ARDB exposes list, show, create and diagnostic lifecycle actions over the same authorized Host-management contract. Pause/resume/check are debugging primitives, not everyday product controls. See the [ARDB commands](../packages/agent-remote-debugger/README.md). Existing Relay ownership and mutation checks apply. Shared guests cannot manage the owner's TPM catalog.

Deploy the compatible Relay before enabling updated Controllers. Controllers advertise TPM management; the Relay never probes new paths on old Controllers, so normal old sessions stay connected. Providers without both instruction and callable-tool capabilities are not offered for TPM creation.

Check a registered Host's fresh server diagnostics for the deployed `workerVersionId` before activating a TPM Controller. A newly served website does not prove that the Durable Object has replaced its old Relay runtime. During the initial rollout, the old runtime rejected the new registration field and the launcher correctly restored the previous Controller. Retry only after the running Relay version matches; see the [deployment readiness check](current/agent-remote/deployment.md#cloudflare).

## Validation boundaries

The regression suite covers persistent receipts, unknown outcomes, revision conflicts, bounded concurrency and fairness, busy-session queueing, pause/completion, tool argument validation, native ownership, and real HTTP/WebSocket authorization and reconnect boundaries. A real Host-uplink test disconnects its only Relay connection and verifies continued heartbeat delivery with one native observation.

Isolated native checks in this implementation exercised Copilot creation and cold resume with two successful Host-tool callbacks. Claude's first native callback succeeded; cold resume failed on the locally installed CLI 2.1.128 both with and without extensions. Codex native smoke was blocked before creation because that environment lacked the API key required by its native configuration. Adapter tests cover all three extension paths, but these local results are not an end-to-end native acceptance claim for every provider.
