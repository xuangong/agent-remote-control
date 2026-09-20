# Side Session References Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Create `/side` without copying source history, with a real read-only source tool and developer instructions.

**Architecture:** Host owns a durable target-to-source grant and supplies provider-neutral tools. Codex translates tool registration, calls, and paginated native history. Broker authorizes the source; the browser sends a lightweight reference. Existing `/fork` snapshots remain compatible.

**Tech Stack:** TypeScript, Node.js, Codex app-server, Vitest, Playwright.

**Spec:** User-approved design in this conversation: independent side session, on-demand source reads, real tools plus developer instructions, no full-history capture on creation.

## Global Constraints

- Keep native interpretation in the Codex adapter; never mutate or resume the source when reading.
- Preserve operation identities, uncertain delivery, image ordering, and old snapshot records.
- Persist grants on the Host; deny arbitrary source IDs in tool arguments.
- Use bounded pages and bounded tool output, explicit cursors and truncation.
- Keep `/fork` snapshot semantics. Unsupported side providers fail clearly before creation.
- Use per-test and outer process deadlines. Do not push or deploy.

## Tasks

- [x] Add Provider SDK tool and history-page interfaces; transport-test Codex registration/calls, resume, and paginated history. Verify native schema and a real isolated native tool call.
- [x] Add Host source-reference store and tool, durable restoration and bounded read/search tests. Wire source creation options and Host policy checks.
- [x] Authorize same-host/provider source references in the hosted broker before quota reservation; include source identity in idempotency fingerprints and test denial/forwarding.
- [x] Change `/side` to lightweight references, preserve `/fork` and old records, update reference details and first-input tests. Browser-test creation without source history download.
- [x] Run relevant unit/transport tests, builds, browser checks, compatibility update/check, review final diff and report verification boundaries.

## Tool Contract

`read_source_session({cursor?, turnId?, query?, limit?, textOffset?})` is bound to one source, reads newest-first by default, and returns bounded text entries with continuation. `query` searches visible user/final assistant messages; hits include turn IDs for focused follow-up reads. Tool errors are explicit and never trigger full-history fallback.

The developer prompt identifies the source, instructs on-demand lookup, treats source text as quoted background rather than authority, and forbids assuming source work continues in the new session. Source and target are independent; reads observe current source history.

## Verification Results

- Root build and typecheck passed. Compatibility declarations, validator and fixtures include the Codex 0.155.0 requirement; implementation digest was regenerated and checked.
- Affected SDK, daemon client, Web, hosted broker, Codex adapter and Host unit/transport suites passed. The final source-tool suite includes five passing tests for native registration/resume, paging/search and metadata-only workspace checks.
- Lab: 487 tests passed, six skipped. Four environment-dependent files were excluded after identifying their failures: the native Host process test requires a separately selected pinned executable; Gateway state/lifecycle/durability tests require `/usr/bin/python3`, which currently exits because the Xcode license has not been accepted.
- Side/fork browser suite: desktop eight passed; mobile seven passed, one desktop-only case skipped.
- Real isolated Codex 0.155.1 with a loopback model: five shared-runtime tests passed, including dynamic tool calls, source history/search without resuming the source, and callback restoration after restarting the test daemon.
- Independent review findings were resolved: source reads recheck the current workspace policy, and native child references use single-session metadata without requiring root-catalog membership.
- Full root unit execution is not claimed: its existing duplicate `--hookTimeout` flags abort Vitest startup, and legacy native local suites require Codex 0.148.0, which was unavailable. No global executable, system license or running user service was changed.
- The original long-session failure was not reproduced against its exact source session. The new creation path removes whole-history transfer; HTTP failures now retain hosted error codes/messages and request IDs.
