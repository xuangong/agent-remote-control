# Claude YOLO permission mode

## Purpose

Claude sessions offer a YOLO permission mode that skips native permission prompts. A single mode table defines every mode the adapter knows, which modes a session may resume into, and how each one is labeled. The adapter stops carrying the same allowlist in four hand-maintained copies that drift apart.

## Modes

The Claude adapter owns one ordered table of permission modes. Each entry carries the native mode value, its display label, an optional explanation, and whether the mode is resumable.

`default`, `acceptEdits`, `dontAsk` and `bypassPermissions` are resumable. `plan` is not. Planning is transient state carried by the planning flag, so a resume target is always a non-planning mode. Recording that distinction as a field replaces three separate lists that each expressed it by omission.

`bypassPermissions` is labeled YOLO and explains that it skips permission prompts while existing sandbox restrictions still apply.

The table is the only place that decides which modes exist. Setting validation derives from the offered options, so a mode absent from the table cannot be selected, and a mode present in it needs no separate validation entry.

## Offering

Every session offers all table modes. A session's current mode always appears among its options, so a selector never renders an unmatched value, and re-selecting the current mode is not an escalation.

Sandbox confinement and permission prompting are independent. A session that the Host restricts to the native sandbox still offers YOLO: the sandbox governs what a command may reach, the permission mode governs whether the operator is asked first. Restricted sessions keep the mandatory sandbox with no unsandboxed fallback while in YOLO.

Changing the permission setting over the remote channel already requires recent authentication, so a stale credential cannot raise a session's privilege.

## Persistence

A session persists only resumable modes. The persisted mode survives planning: entering and leaving plan mode returns the session to the mode it held before.

A restricted session starts at `default` and does not resume a saved elevated mode. Elevation stays a deliberate act taken once per session rather than a setting that silently carries forward.

Persistence validation, stored-configuration parsing and native evidence admission all consult the same resumable set. A mode the adapter can write is a mode it can read back and admit as evidence. Older Hosts that do not know a newer mode drop it and fall back to `default`, degrading toward the more restrictive side.

## Native confirmation

A session reports the permission mode the native runtime actually holds, including a mode the adapter does not offer. The displayed state follows reality rather than reporting a lower privilege than the session has.

Persistence stays strict while display stays truthful: the session records a confirmed mode as its resume target only when that mode is resumable. An unrecognized native mode is shown but never written, so the adapter cannot persist a value its own readers would later reject as invalid.

Selecting a mode takes effect only once the native runtime confirms it. While a change is in flight the session continues to report its previous mode, and native policy may reject the change, leaving the previous mode in place.

## Testing

Native coverage exercises YOLO against a real Claude runtime, both with and without the restricted sandbox: a tool runs to completion, the workspace shows its effect, and no approval interaction is requested.

Adapter coverage asserts that a selected mode survives a planning round trip and reaches persistence, that an in-flight change is not reported before confirmation, and that a rejected change leaves the previous mode intact.

One test closes the loop that the former duplicate lists left open: a mode written to persistence parses back from stored configuration and is admitted as native evidence. Another asserts that an unrecognized native mode is displayed without being persisted.

## Documentation

The Host guide lists the modes Claude exposes, states that YOLO skips prompts while preserving the command sandbox and workspace admission, and records that restricted sessions reset saved elevated modes when reopened.
