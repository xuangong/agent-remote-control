# OpenCode v2 normalization fixtures

`v2-fixtures.ts` uses isolated values in the exact OpenCode 2.0.25 native wire
shapes. It is a schema-based fixture, not a recording from a user's session.
The installed `@opencode/client@2.0.25` types check every fixture record.

The source contracts are pinned to the official `v2.0.25` tag:

- `packages/schema/src/session-message.ts`: user `text`/`files`, assistant
  `content`, shell, compaction, idle and synthetic records.
- `packages/core/src/tool/plugin/edit.ts` and `patch.ts`: completed
  `metadata.files` contains `file`, `patch` and `status`.
- `packages/core/src/tool/plugin/subagent.ts`: child identity is
  `metadata.sessionID`; completed replies use the documented native tool wrapper.
- `packages/core/src/tool/plugin/shell.ts`: shell result content and exit metadata.

Tests intentionally preserve these interpretation boundaries:

- A page without a known beginning cannot establish a turn before its first
  native idle boundary. Inputs inside a known active turn remain steers.
- System instructions, skill internals and selection records are not displayed
  as ordinary user or assistant messages. Synthetic input is labeled
  `[Injected context]`, without an editable message identity or a new turn.
- A failed compaction replaces its loading entry with the actual error. It is
  never reported as a successful compaction.
- File changes come from completed native result metadata. Approval previews,
  requested write content and unknown rename origins are not final diffs.
- Communication needs explicit parent and child session identities. A returned
  child response additionally needs the native completed result; invocation time
  does not establish the child's message delivery time.
