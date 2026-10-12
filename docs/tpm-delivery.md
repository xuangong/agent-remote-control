# TPM delivery workspaces

A TPM is a normal agent session accountable for one agreed work item. It clarifies the user's need, maintains a plan and acceptance criteria, coordinates implementation with a bound main session, examines evidence, and reports back. It does not implement product code itself. A main session can serve multiple independent work items.

## Using the workspace

Use `/tpm` or the View menu to show or hide the global TPM entry. `/tpm on`, `/tpm off`, `/tpm enable`, and `/tpm disable` are also supported. Without an explicit saved preference it is visible on coarse-pointer/mobile devices and hidden on desktop, independently of Track.

Select a supported main session and choose **New TPM session** to open a conversation directly. No title or requirement form is needed. Unnamed sessions receive a color-and-flower placeholder such as **Amber Iris**. Click the title and pencil to rename at any time; user-chosen names are preserved by automated work updates. A vague intention is enough: use the conversation for research, requirements and solution design, then follow implementation through acceptance. The objective and plan can evolve as discussion makes them clearer. The TPM asks what the user wants and waits for their reply; it must not infer an assignment from main-session activity. Once discussion establishes the objective, it sets a concise work title through `update_work`. API callers can still supply an optional title and initial requirement. The catalog refreshes automatically, including when the menu opens or the window regains focus. Opening a work displays the ordinary Session View and full composer in an Ask-style workspace. Desktop workspaces can be resized; small screens use an overlay. Conversation is primary. **Plan & acceptance** opens the TPM-maintained Markdown document, which can remain empty while the need is still being clarified. The document is not automatically an approved specification.

New work starts in manual mode: conversation and task tools work normally, but neither periodic heartbeats nor main-session changes start automatic reviews. Select **Delegate** in the workspace to enable background follow-up; **Delegated** turns it off again. The setting is persisted by the Controller and shared across devices. Existing work created before this setting retains automatic follow-up. Closing, minimizing, changing sessions, or hiding TPM view preserves drafts and never changes delegation. Stopping delegation cancels only undispatched automatic reviews, not an accepted native turn. The product does not expose low-level heartbeat controls. Talk to the TPM to discuss progress or change direction. Work progress and native runtime status are separate facts. A main session finishing unrelated work never marks the TPM work complete.

Every conversation, including main, Side, Ask, and TPM, uses the ordinary Session View. TPM adds a workspace around it, not a separate chat renderer, reduced composer, or connection state machine. Timeline rendering, search, display preferences, model and permission controls, drafts, and recovery stay in the common view and client. The work list, progress assessment, and Plan & acceptance are outside that boundary; container size determines responsive presentation.

TPM composes the standard [session companions](session-companions.md): a sequential execution list, explicit user confirmation, and heartbeat. Open **Todo** inside the Session View to inspect the current step and remaining work. Confirmation shows the concrete proposal and provides **Agree** and **Needs changes**. The model cannot approve these steps itself. Chat remains available while a decision is pending; conversational discussion alone does not record approval.

The initial list covers clarification, plan agreement, implementation, verification, user acceptance and reporting. TPM can edit remaining steps at boundaries, while completed history stays intact. Revisions to an approved plan require fresh agreement. The expanded list overlays the current view without moving the timeline or composer.

Work can be stopped and archived from its workspace at any point, including while requirements are unclear or a todo is unfinished. Archiving pauses automatic follow-up, retains the actual phase, todo, conversation, documents and evidence, removes it from the active menu count, and places it in the collapsed **Archived** list. It does not claim completion. Messages still waiting in the Controller are rejected before dispatch; already dispatched native requests retain their real receipts and are not canceled. Open an archived work to read or restore it. Restoring leaves follow-up paused; resuming is a separate explicit action. **Resume work** and **Reopen work** restore active work while preserving its delegation setting; manual work still requires **Delegate** to enable automatic follow-up. Reopening completed work also removes the archive marker.

TPM also ends tracking itself when the agreed delivery is complete: after every todo task, required user confirmation and work-specific acceptance evidence, it reports the result and calls `complete_work`. Completed work remains visible for review until the user archives it. Neither closing the workspace nor the main session becoming idle completes the TPM work.

## Background behavior

The Controller keeps records beneath its state directory in `tpm-v1`. For delegated work it holds background session leases and subscribes to the existing shared managers. It never calls native `observe()` a second time. Same-Controller coordination continues without a browser or Relay connection; the machine and model endpoint must still be available.

While delegated, committed main-session content and relevant waiting/failure/completion boundaries request a coalesced review. Token streaming, usage updates, and history pagination do not independently trigger reviews. The initial defaults are a five-minute heartbeat, thirty minutes while waiting for the user, a two-second event window, a thirty-second minimum automatic review interval, and two concurrent automatic reviews per Controller. Busy TPMs are not interrupted. Main-session messages use native next-turn delivery when available, otherwise remain in a Controller queue until ordinary input is admissible.

TPM instructions require an explicit work-state update after each review. A review receipt alone does not mean that work progressed. Overdue accepted reviews with no assessment are checked using a new reflection after the native session is confirmed idle. The old input is never replayed.


### Quiet reviews and provenance

Each automatic input has a unique review ID and a bounded, durable Host record containing its exact input hash. The Host annotates normalized timeline items only after matching that input to a native turn. Adapters still own native interpretation; the annotation is application provenance, not a new native execution status. No arbitrary prompt prefix or acknowledgement text is treated as proof. Up to 2,048 recent review records are retained; older or unassociated native history stays visible. Providers/pages without a reliable turn identity retain ordinary rendering rather than guessing a correspondence.

An assessment supplies `reviewId` and `notify` to `update_work` or `complete_work`. It is settled once. A quiet assessment preserves unchanged summary and next-action text; changed phase or waiting state is always visible. Missing assessments, human input within the turn, failures and pending interactions cannot be treated as quiet success. Manual discussion, approved main-session communication, and explicit todo confirmation remain usable without delegation. Confirmation can request a single response without turning periodic reviews on.

The shared Session View collapses adjacent annotated background spans into **Background checks** with a count. Expand it to inspect the original input, reasoning, tools and quiet acknowledgement. Meaningful replies, communication, errors and interactions remain in the conversation. Search and Trace reveal the original target. ARDB recording/replay retains the same annotations and original text. This reduces visual clutter; it does not delete native history or claim to reduce already accumulated native context tokens.

Explicit background outcome events update earlier annotations by review ID, including lifecycle-only failures and human steers; subsequent ordinary turns never erase that outcome. The manager publishes a separate attention cursor and current background outcome. Quiet checks do not advance unread content or produce a completion notification. Real input requests still notify, and a visible assessment can notify even if it arrives after idle. Reconnection preserves the manager's attention boundary. Older Controllers without this contract retain ordinary behavior and do not expose the delegation button.

## Bound tools and authority

Tools can only access this work and its bound main session:

- `read_work`: current requirement, assessment, pending intents, plan, and document versions.
- `read_main_session`: authoritative state and bounded, paginated history; search is explicitly limited to the returned page.
- `send_main_message`: persist a current-step consultation, implementation request, or acceptance feedback without interruption; recheck the step and applicable user approval before native dispatch.
- `update_work`: revision-checked assessment and optional work title; completion requires every todo step, acceptance criteria and evidence.
- `complete_work`: explicitly finish an accepted delivery and stop background follow-up through the same completion checks as `update_work`; does not archive it or bypass user confirmation.
- `write_work_document`: update the work document and retain bounded document versions.
- `schedule_check`: request an earlier review within Controller limits, only while delegated.
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

## Work navigation and responsive layout

The global list groups active TPM work by its bound main session. Archived work uses the same grouping. Headings use known session titles and directory metadata (Host, provider and workspace when available). Identity includes the Host, main provider and native session ID; a main-session reference after Handoff takes precedence over the TPM's own provider. Resolving a heading reads the directory without attaching to the main session.

Selecting a work keeps the list and its floating trigger available. Multiple TPM workspaces can stay open on wide screens. Focusing one brings it forward; minimizing it preserves its session and draft without minimizing other workspaces. On small screens the focused workspace occupies the screen and the list switches between retained workspaces. The list can still be closed explicitly.

Ask and TPM windows share **Dock** presentation when the viewport is wider than 1180 px, matching the existing side-by-side breakpoint. This depends on available width, not device type; a wide tablet can use Dock too. Docked windows append to the right of the existing main/subagent composition. That composition remains one logical group: ancestry, its width ratio and communication-envelope navigation are unchanged. Only docked windows can be reordered, using their heading grip (or its left/right arrow keys). Edges resize individual widths; overflow is scrolled horizontally. New docked windows start at 440 px. The main/subagent group's outer width is separately adjustable.

Dock is local presentation state, not a new session relation or native operation. A stable portal host moves the same Session View between floating and docked containers, preserving the mounted client, drafts and timeline state. Returning to a small screen temporarily uses the original overlay presentation; returning to a wide viewport restores the current page's docking layout. Dock order is not persisted across page reloads. Minimizing a TPM temporarily removes its pane; reopening restores its place and width. Floating a pane removes its docking entry; docking again appends it at the end.
