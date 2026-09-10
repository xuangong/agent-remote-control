# Context forks and side conversations

The approved design creates independent sessions from a fixed snapshot of normalized chat history. `/fork` leaves the main conversation in place and provides an entry above its composer. `/side` and `/btw` open the fork alongside it. A permanent source tag identifies the source native session, capture time and history boundary. Closing a side view does not close its runtime. Fork ancestry is separate from native subagent ownership.

The console uses existing directory creation, history and message APIs. It captures a single bounded tail projection and uses its canonical window as the boundary. Incomplete responses fail explicitly; independently changing pages are never combined. Complete user and assistant messages and bounded tool detail/result excerpts become quoted context; reasoning, diagnostics and sensitive interaction responses are excluded. Context is included with the first user input, never as a system prompt. Only the exact recorded context envelope is removed from the displayed user message. Native persistence retains the actual input.

Fork records are stored separately from the opened-session list in browser storage, keyed by host, provider and native session. Storage must succeed before creating a session. Creation retries use the same request identity. An uncertain first send is never automatically repeated; reconciliation checks native history for the exact envelope. This is a browser-local context attachment, not a native runtime fork or a full native context export.

## Implementation and validation

- [x] Add snapshot capture, curation, durable records and one-time context delivery in `src/session-forks.ts`; test canonical boundaries, spanning tool results, long dialogue, oversized tool excerpts, incomplete snapshots, history gaps, storage failure and uncertain delivery.
- [x] Add explicit console commands to the shared composer without changing Provider command capabilities or wire schemas; test command precedence and aliases.
- [x] Add independent side-chat client lifecycle and reference UI; wire fork entries and restored sessions into App. Test independent sends, closing/reopening and source visibility.
- [x] Run focused unit tests, typecheck/build, compatibility update/check and browser flows on isolated ports. Review the final diff and document practical limits.
