# Mobile view sizing

All built-in views must fit their containing viewport. Long unbroken values wrap
inside cards; flex and grid tracks must be allowed to shrink. Hiding overflow on
the page is not a substitute for sizing the content correctly.

## Boundaries

| Surface | Expected behavior | Regression coverage |
| --- | --- | --- |
| Resources | Locators and errors wrap; status stays readable; actions wrap. | Pending, available, failed and unavailable cards; loaded download links; long locator through the recorded Relay. |
| Conversation | User/assistant messages, reasoning, tool details/results, tasks, completed questions, errors and compaction fit the conversation. | Every Timeline item type; expanded details for all seven tool types; long links, inline code, text and JSON results. |
| Failed tools | Errors remain visible when details are collapsed, using 12px monospace text with preserved newlines. Long errors scroll within a 320px-high block. | Multiline lockfile diff, phone/desktop sizing, keyboard access and local scrolling. |
| File changes | Expandable file cards wrap long paths and show change labels and patch line counts. Unified diffs preserve indentation and scroll inside a 320px-high region using 12px monospace text. | Added, modified, deleted, renamed, binary and empty patches; separate old/new line numbers; keyboard scrolling; 320/390/844/1440px desktop and touch layouts. |
| Pending interactions | Questions, plans, tool/permission approvals, external actions and forms fit the panel. | All six interaction types with long labels, options, paths and descriptions. |
| Markdown | Prose wraps. Code blocks and tables can scroll horizontally inside their own bounds. | Narrow and wide layouts; local scrolling remains available. Images render as alternative text; resource links open separately. |
| Trace | Names and metadata wrap; rows grow to contain their content; the list scrolls vertically. | Long provider/epoch/tool values, row containment and viewport bounds. |
| Replica Inspector | Snapshot values, provider names and diagnostics wrap. | Long identifiers, model, mode and diagnostic text. |
| Skill details | Heading, description and documentation stay inside the details panel. | Long names/descriptions and Markdown documentation. |
| Controller panels | Header, Sidebar, Settings, session controls and Side conversations stay within their assigned viewport. | View toggles plus existing mobile, directory, recorded and session-fork browser suites. |

The sizing suite is `packages/agent-remote-lab/e2e/view-overflow.spec.ts`. It runs
at 320, 390, 844 and 1440 CSS pixels under both desktop and touch Chromium
projects. It measures internal scroll widths and element bounds, so an outer
clipping container cannot conceal oversized cards. Intentional ellipsis,
screen-reader-only content and native select internals are excluded from the
content-width assertion; visible control bounds are still checked.

This is deterministic browser coverage without model calls. It does not assert
physical iOS Safari testing, arbitrary third-party renderer behavior, or support
below the application's existing 320px minimum width.

## Conversation previews

View's **Content only view** checkbox appears above **Simple conversation view**. The two modes are mutually exclusive; clearing the selected mode restores default previews. Content only renders user messages and assistant text/Markdown, including inline Markdown images and links, and groups adjacent visible messages. It also retains plan/task-management tool calls, task boards with their live completion states, and completed interactions including answered questions and approval decisions. Retained tools and answered questions use bounded previews with expandable details. Reasoning, other tools, runtime notices, compaction, resource cards, preview registration controls, renderer extensions, inline subagent lists and Trace shortcuts are hidden. The complete replica remains available to Trace and the other conversation modes. Pending interaction controls and outgoing message delivery feedback remain available. A loaded history page with no matching items shows an empty content state and retains older-history navigation. Browser storage remembers the mode for both primary and Side conversations. Explicitly choosing Show in Conversation for a hidden execution event in Trace switches to Simple mode so the target can be revealed.

The default conversation shows bounded previews before full disclosure. View's
**Simple conversation view** checkbox restores the title-oriented display for
untouched items. This preference is stored in the current browser and applies to
the main conversation and Side conversations. Individual expand/collapse choices
survive content updates and changes to the default mode while the item is mounted.

| Element | Default preview | Full disclosure |
| --- | --- | --- |
| Tool calls | Shell command and up to two received result blocks; no invented result when none was reported. | Complete bounded result, command details and existing raw JSON disclosure. |
| File changes | First three files, change labels and received patch counts; each diff starts at its first unified hunk when present. Paths wrap to two preview lines. | All received file paths and diffs. |
| Reasoning and runtime notices | Up to four lines of supplied text, three below 641px; no generated summary. | Original Markdown reasoning or complete diagnostic text. |
| Completed questions | Brief question prompt beside the existing answer. | Complete prompt and description. Sensitive answers remain redacted. |

Code/diff previews show up to six lines, four below 641px. Text extraction is
bounded to 2,400 characters per preview; the complete result remains available
through disclosure. Preview code scrolls horizontally within its own width and
does not create a vertical scroll region. Expanded results retain their existing
local scroll limits. Counts always refer to the received patch, not just preview
lines. Full details are rendered lazily when opened.

Messages, pending interactions, plans, resources and subagent links keep their
existing presentation. Failed tool diagnostics stay visible in both modes.
No provider, Relay or wire contract changes are required. Browser coverage is in
`e2e/conversation-previews.spec.ts`, including narrow layouts, mode persistence,
local scrolling and full-result access.

## File-change data

The Provider SDK's `fileChangesResult` helper writes a versioned
`{ format: 'file_changes', version: 1, files }` presentation value into the
existing JSON tool-result channel. Each file supplies `path`, `kind`, `diff` and
an optional `previousPath`. The Remote 1.4.0 wire union remains `text | json`;
older clients can display the JSON without understanding this presentation.

The Codex adapter normalizes native file changes on live completion and history
replay, including `update.move_path` renames. Existing edit/write results with
plain path/diff arrays also render, with a neutral File change label: the client
does not interpret native kind metadata. The Raw result disclosure retains the
received JSON. Unknown versions or malformed structures use the normal JSON view.

Counts describe added/deleted lines in the received patch, not a comparison with
the filesystem. Line numbers require unified hunk headers; snippets and binary
notices remain readable without fabricated numbers. The existing result budget
still applies: oversized JSON falls back to explicitly truncated text rather than
claiming to contain a complete structured diff.

This change does not add native patch normalization for Claude, Copilot or DSH.
Their text/JSON results remain visible, and any adapter can adopt the SDK helper
when its native result provides the required fields. A Host update is needed for
new Codex change labels; the client can render existing path/diff history before
that update. Deterministic rendering coverage lives in `e2e/file-changes.spec.ts`,
with native adapter tests and real WebSocket/reconnect/history coverage in
`src/tool-result-transport.test.ts`.
