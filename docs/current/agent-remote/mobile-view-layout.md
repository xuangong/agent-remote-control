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
