# Inline image input design

Date: 2026-09-20
Status: Approved by the user on 2026-09-20; implementation in progress.
Branch: `feat/inline-image-input`
Baseline: `b61a56e`

## Goal

Let a user paste or select images inside a message and edit each image as an
indivisible inline tag, such as `[image #1]`. Preserve the relationship between
text and image positions in provider input, native history, Remote replay,
draft recovery, and explicit retries.

Example:

```text
The current result is [image #1]. Match [image #2], especially the header.
```

The canonical message is an ordered sequence of text, image, text, image, text.
An attachment gallery plus a flattened prompt does not satisfy this requirement.

## Scope and boundaries

- First delivery supports Codex and Claude sessions that accept image input.
- Copilot and DSH keep text input. They do not advertise image input until their
  native adapters preserve the required semantics and pass transport tests.
- The input remains plain text with Markdown syntax, line breaks, and image
  atoms. No rich-text formatting toolbar is introduced.
- Existing slash commands, selected skills, native busy-state routing, send-button
  hold-to-newline, side conversations, and editable drafts during reconnect remain.
- Image input does not change pairing, account identity, model selection, or
  provider credentials. Hosted authorization stays in the hosted boundary;
  standalone use does not acquire an account dependency.
- No deployment, package publication, Host replacement, or merge is part of
  implementing this design without a subsequent user instruction.

## Verified starting points

| Boundary | Current implementation | Required change |
| --- | --- | --- |
| Composer | `agent-remote-web/src/react/AgentComposer.tsx` uses a textarea, a string draft, and an external React attachments slot | Introduce an inline document editor and image atoms |
| Client | `agent-remote-web/src/client/remote-session-client.ts` sends text; retries retain text | Carry immutable ordered content and attachment identity |
| Outbox | `agent-remote-web/src/replica/message-outbox.ts` matches new native echoes by normalized text | Match multimodal messages by ordered content and image identity |
| Protocol | `agent-remote-protocol/src/messages.ts` and `timeline.ts` accept text-only user messages | Define ordered input and replay content, plus upload operations |
| Session boundary | `agent-remote-relay/src/session-wire.ts` validates identity and executes tracked message operations | Authorize uploads and include full message content in operation parameters |
| Resource boundary | `agent-remote-relay/src/resources/` supports resource ingestion, dimensions, and reads | Add incoming image storage; reuse existing authorized preview reads |
| Codex | `session.ts` constructs text-only `turn/start` and `turn/steer`; `projector.ts` flattens user content | Map and recover ordered native text/image input |
| Claude | `session.ts` sets a string SDK message; `projector.ts` filters user blocks to text | Send and project ordered SDK content blocks |
| Recovery | `agent-remote-lab/src/conversation-recovery.tsx` stores string drafts | Add versioned rich drafts with browser-local blobs |

All paths in the table are under `packages/`. The hosted broker limits HTTP
request bodies to 64 KiB, and the Host uplink limits public requests to 1 MiB.
Increasing these limits to accommodate photographs is not the upload design.

## Editing behavior

Use a minimal ProseMirror schema with text, paragraphs/line breaks, and a leaf
inline image node. The image node is selectable and has no editable child DOM.
The domain draft is independent of ProseMirror's document JSON.

- Paste inserts actual image files from the paste event at the current selection.
  Normal text paste retains existing behavior. A copied URL remains text;
  arbitrary clipboard HTML and remote image URLs are not fetched automatically.
- An upload button opens an image file picker. Capture the selection before
  opening it; map that position through any intervening document edits before
  inserting the chosen files. Preserve selection order for multiple files.
- Insert the tag immediately and let the user continue typing while it uploads.
- Arrow navigation, range selection, Backspace/Delete, cut/paste inside the app,
  and undo/redo treat the image as one atom. Deletion is a document edit, not an
  immediate destructive deletion of its bytes; undo must restore the image.
- A selected tag exposes Preview and Remove actions. Preview is an overlay;
  loading or opening it does not expand the composer.
- Tag labels have stable numbers within the draft. Removing an image does not
  silently renumber the other tags. The number is presentation metadata;
  identity is a generated image ID. Typing `[image #1]` creates ordinary text.
- Copies within the application preserve the atom and image identity through a
  validated application clipboard format and local blob lookup. External copies
  have a readable text fallback; a missing blob never becomes a valid attachment
  merely because the pasted text resembles a tag.
- Mobile text selection, Chinese IME composition, accessibility labels, Enter,
  Shift+Enter, slash commands, and hold-Send newline are acceptance requirements.
- Keep the current composer position, height cap, and independent side-window
  drafts. Do not replace the composer with an image-dependent layout.

## Domain model

The editor, public protocol, and provider adapter use separate representations.

```ts
type DraftPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageId: string; label: string };

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; label: string };

type MessageContent = readonly MessagePart[];
```

The draft owns an image table containing local blob identity, detected MIME type,
dimensions, upload state, and the returned attachment reference. Large bytes do
not live inside document nodes, protocol timeline events, or sessionStorage.
Adjacent text parts may be merged; content must never be reordered.

The public `send_message` payload accepts exactly one of legacy `text` or new
`content`, with the existing request ID, operation ID, agent ID, and delivery
mode. Keep the old text shape for text-only callers. Reject ambiguous payloads
containing both. Image-only messages are valid when all images are ready.

The Provider SDK adds an optional `sendMessageContent(parts, options)` method and
an explicit image-input capability. Its image part contains a Host-resolved,
immutable local file reference and MIME type, not a client-supplied path or URL.
Existing `sendMessage(text, options)` adapters continue to work unchanged.

Capability publication includes supported MIME types and effective limits.
Absence of the capability means unsupported. Session permission and native
runtime readiness still apply independently. Model-specific rejection remains
a visible provider error rather than silently converting the image to text.

## Upload and storage

Use bounded upload commands on the existing authenticated full session transport;
the activity transport does not carry image data. No new public image service or
Cloudflare blob bucket is required.

Upload lifecycle: `begin -> chunk(s) -> finish -> attachment reference`.
Begin declares upload ID, image digest, byte length, and media type. Chunk carries
upload ID, byte offset, and base64 data; finish verifies complete bytes and digest.
Begin and exact repeated chunks are idempotent. Conflicting bytes at an accepted
offset fail explicitly. The server reports the contiguous accepted byte offset
so a reconnect can resume without uploading accepted bytes again.

Defaults for first delivery:

- Accepted types: PNG, JPEG, WebP. Reject unsupported formats with a specific
  message before sending. In particular, HEIC is not silently relabeled as JPEG.
- At most 8 image atoms, 10 MiB per image, and 20 MiB combined unique image bytes
  per message. The Host enforces limits in addition to the browser.
- At most 32 KiB decoded bytes per chunk and one acknowledged chunk in flight
  per client upload queue. Other message/control traffic can proceed between
  chunks; do not hold the Agent command execution lock while uploading.
- Do not silently resize or recompress screenshots in the first delivery.
  Detect actual file type, validate dimensions, and reject invalid image data.

Uploads are scoped to the authenticated session's durable identity, not just a
temporary Agent ID or a transport connection. A hosted scope includes the
authorized tenant/Host/provider/native-session identity. The standalone scope is
injected by its pairing/session boundary without importing hosted accounts.
Read-only shares and activity-only sessions cannot upload or send images.

Store completed bytes and their manifest under the Host state directory, outside
the user's source tree, using generated paths and atomic completion. Persist
upload receipts across Host restart. Attachment IDs are opaque and scoped;
knowing a digest or ID does not grant access to another session's bytes.

Unfinished and never-submitted uploads expire after 24 hours of inactivity.
Once referenced by a dispatched operation, retain images needed for uncertain
delivery, native resume, or history preview; do not expire them on the draft TTL.
Use a configurable Host storage quota (1 GiB default) and reject new uploads
clearly when full instead of deleting referenced history. Explicit session/data
cleanup can reclaim retained attachments in a subsequent lifecycle operation.

## Sending, switching, and recovery

The browser retains versioned drafts and Blobs in IndexedDB. Key them using the
existing recovery scope plus stable conversation identity. Migrate existing
string drafts into one text part. Do not overwrite a draft if hydration finishes
after the user has begun a newer edit.

- Draft construction is allowed while reconnecting. Upload starts/resumes when
  the correct full session is ready and its image capability is known.
- Switching sessions pauses that draft's uploader. Late completions may update
  only the captured draft/image identity, never the newly selected session.
- A side conversation has its own draft and upload ownership. Copying an image
  to another session reuses local bytes but requires a new scoped upload.
- Browser storage failure leaves an editable in-memory draft and clearly reports
  that recovery is unavailable; it must not erase the draft.
- Missing local bytes after restoration produce an unavailable tag with Remove
  and Replace actions. Never submit a text-only substitute.
- Garbage-collect only blobs unreferenced by drafts, retained editor undo
  history, or the outbox. Signing out removes account-scoped image draft data.

The Send action snapshots the document and attachment references. It is enabled
only when the message has content, all referenced uploads are complete, and
normal session readiness/capability checks pass. Upload failure remains visible
on its tag with Retry/Remove; it does not clear text or invoke the provider.

Native send failure and uncertain delivery use the existing outbox behavior.
Retry retains exact text/image order and image references. Reusing an operation
ID requires identical canonical parameters, including all image references.
An upload acknowledgement is never a message-delivery acknowledgement.

## Provider input and history

### Codex

Map ordered parts to the existing app-server input array: text parts become text
inputs and image parts become `localImage` inputs backed by managed Host files.
Use this mapping for both `turn/start` and the active-turn `turn/steer` path.
Preserve current active-turn race handling and no-automatic-resend behavior.

Validate against the installed supported daemon version, not only upstream main.
The `rust-v0.148.0` conversion already iterates user inputs in order. Generated
native labels are adapter details; round-trip correlation uses image identity
and placement, not a regex matching the display label.

### Claude

Map ordered parts to `SDKUserMessage.message.content`: text blocks and image
blocks containing base64 data from the validated Host file. Keep the existing
streaming-input session. Unsupported active-turn sends continue to obey the
adapter's existing busy-state policy.

### Replay and display

Extend normalized user-message observations and public timeline items with
ordered content. Native adapters register image resource references while
projecting the native message; they must not filter images out or emit an empty
message for an image-only input. Byte payloads stay in the resource reader.

Use the same inline image tags and preview behavior for outbox entries and
confirmed user messages. Resource metadata reserves stable preview dimensions.
Reading history from an empty browser cache must recover positions and image
resources from native history plus the Host attachment manifest, without a
browser-only echo overlay.

Reconciliation prefers a provider-supported message correlation ID. When the
provider cannot echo one, compare new user entries by canonical ordered content
and scoped image digests, consuming each occurrence once. Text equality alone
cannot confirm an image message. Ambiguous/missing native echoes leave delivery
unconfirmed rather than consuming the wrong pending message.

## Compatibility and implementation sequence

The current codec requires an exact protocol version and strict object shapes.
Introduce this contract as Remote protocol `1.5.0`, update public schemas,
fixtures, native replay tests, and compatibility metadata together. The hosted
browser and Host need matching releases. Uplink envelope version remains 2
unless its envelope itself changes. No claim of mixed-version support is made.

Implementation slices, each with behavior tests:

1. Protocol and Provider SDK content/capability contracts; preserve text-only
   behavior and reject malformed mixed input before any provider work.
2. Scoped Host image upload/storage and authorized resource reads; real transport
   coverage of retry, ownership, limits, restart, and session switching.
3. Codex/Claude native input and projection; ordered text/image round trips for
   start, supported active-turn input, native replay, and image-only messages.
4. Client uploader, immutable outbox, structured drafts, and IndexedDB recovery.
5. ProseMirror composer, paste/upload UI, atom editing, previews, and integration
   with existing controls and side conversations.
6. Browser/native acceptance, documentation, compatibility update/check, and
   review of the complete branch before any release request.

## Acceptance

- Two distinct images interleaved with three text spans arrive in exactly that
  order at the native input boundary and replay in the same order.
- A supported live vision model identifies distinct test images in a message
  that references their positions. Report this separately from fixture tests.
- Image-only input works; ordinary text and manually typed tag-looking text keep
  their existing meanings.
- Chinese IME, mouse/touch selection, atom deletion, undo/redo, copy/cut/paste,
  file-picker cursor restoration, and hold-Send newline work in Chromium and
  WebKit; report physical iOS clipboard/selection verification separately.
- Upload progress/failure does not move the composer or a visible reading line.
- Sleep/reconnect, mid-upload session switch, parallel side windows, reload,
  storage denial, upload expiry, quota exhaustion, and Host restart produce
  recoverable visible states with no cross-session insertions or automatic send.
- Repeated identical text with different images cannot settle the wrong outbox
  entry. Lost acknowledgements do not cause automatic duplicate native turns.
- Cross-tenant/session attachment references, read-only uploads, invalid MIME,
  corrupted bytes, conflicting chunks, and oversized inputs are rejected.
- All tests have per-test and outer deadlines. Build artifacts before browser
  tests; use free local ports and preserve existing services.

## Evidence

- [Codex 0.148.0 ordered input conversion](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/protocol/src/models.rs)
- [Claude SDK streaming image input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [ProseMirror node schema](https://github.com/ProseMirror/prosemirror-model/blob/master/src/schema.ts)
- [Browser image paste](https://web.dev/articles/clipboard/paste-files)
