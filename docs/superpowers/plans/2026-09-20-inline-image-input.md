# Inline Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste/upload inline image atoms and preserve ordered multimodal input through native delivery, replay, and recovery.

**Architecture:** Public messages reference uploaded images; the Host resolves immutable files before calling an optional multimodal Provider SDK method. The editor owns a plain ordered document, while the client owns uploads and the outbox. Native adapters own interpretation and native history projection.

**Tech Stack:** TypeScript, React 18, ProseMirror, TypeBox, Node filesystem, IndexedDB, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-inline-image-input-design.md`

## Global Constraints

- First delivery supports Codex and Claude sessions that accept image input.
- Accepted types: PNG, JPEG, WebP.
- At most 8 image atoms, 10 MiB per image, and 20 MiB combined unique image bytes per message.
- At most 32 KiB decoded bytes per chunk and one acknowledged chunk in flight per client upload queue.
- Remote protocol `1.5.0`; Uplink envelope version remains 2.
- All tests have per-test and outer deadlines. Build artifacts before browser tests; use free local ports and preserve existing services.
- No merge, push, deployment, or running Host replacement in this execution.

## Shared interfaces

Protocol exports from a new `packages/agent-remote-protocol/src/image-input.ts`:

```ts
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
type MessagePart = { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; label: string };
type UserMessagePart = { type: 'text'; text: string }
  | { type: 'image'; locator: string; label: string; sha256?: string };
type ImageUploadReceipt = { uploadId: string; offset: number;
  attachment?: { attachmentId: string; sha256: string; mediaType: ImageMediaType;
    byteLength: number; imageDimensions: { width: number; height: number } } };
```

Wire requests have `protocolVersion`, `type`, and `payload`. All upload payloads
include `requestId`, `agentId`, and `uploadId`. `image_upload_begin` additionally
has `sha256`, `byteLength`, and `mediaType`; `image_upload_chunk` has `offset` and
`contentBase64`; `image_upload_finish` has no additional fields. Response
`image_upload_result` has `requestId`, `agentId`, and the receipt fields. Input
`send_message` accepts exactly one of `text` or `content: MessagePart[]`.

SDK exports `AgentInputPart = text | { type:'image'; path:string;
mediaType:ImageMediaType; sha256:string; label:string }`, `AgentUserMessagePart`
matching `UserMessagePart`, and `IMAGE_INPUT_CAPABILITIES` with `mediaTypes`,
`maxImages`, `maxImageBytes`, `maxMessageBytes`. Add optional
`AgentSession.sendMessageContent(parts: readonly AgentInputPart[], options?:
AgentMessageOptions): Promise<void>` and `capabilities.imageInput`. Normalized
user items retain required display `text` and optional ordered `content`.

Web client adds `sendMessageContent(content: readonly MessagePart[], options?)`,
`uploadImage(file: Blob, uploadId: string, options?: { signal?: AbortSignal;
onProgress?(loaded:number,total:number):void }): Promise<ImageUploadReceipt['attachment']>`.
The resolved return must be an actual attachment, never undefined.

Composer adds `onSendMessageContent`, `onUploadImage` matching those signatures,
and `draftScope?: string`. Existing text callbacks stay source compatible. The
image draft hook persists by draftScope plus sessionKey and migrates controlled
text. The parent passes a stable account/relay scope. Inactive side views pause
uploads using a `visible` flag or a disabled upload callback without losing draft.

## Task 1: Public/SDK contracts and scoped Host upload

**Files:** Add `agent-provider-sdk/src/image-input.ts`,
`agent-remote-protocol/src/image-input.ts`,
`agent-remote-relay/src/resources/input-image-store.ts` and focused tests.
Modify SDK exports/provider/observation; protocol exports/messages/timeline/
snapshot/version; Relay agent-manager/session-wire; Host injection in host.ts.

**Consumes:** approved limits, existing authorized session wire and resource reads.
**Produces:** shared types above, scoped begin/chunk/finish storage, manager
`sendMessageContent`, upload response routing, persisted immutable files.

- [ ] Add failing schema tests for text-only input, image-only content, mixed
  text+content rejection, path/URL injection, malformed chunks, and capability.
- [ ] Add store tests using temporary directories and actual PNG/JPEG bytes:

```ts
await store.begin(scope, request);
await store.chunk(scope, { uploadId, offset: 0, contentBase64 });
expect(await store.chunk(scope, { uploadId, offset: 0, contentBase64 })).toEqual(receipt);
await expect(store.finish(otherScope, uploadId)).rejects.toThrow();
expect((await reopened.finish(scope, uploadId)).attachment.sha256).toBe(digest);
```

- [ ] Implement sequential file writes, offset conflict checks, receipt recovery,
  byte/digest/MIME/dimension validation, global quota, unsubmitted expiry, and
  pinning before native dispatch. Never use client paths as filesystem paths.
- [ ] Integrate uploads without holding the message command lock; capability and
  identity rejection occur before storage/provider side effects.
- [ ] Include canonical content in operation parameters and resolve every image
  before dispatch. Expose safe resource reads for retained images.
- [ ] Bump exact public protocol version and synchronize versioned fixtures.
- [ ] Run focused schema/store/wire suites with 10-second test and 120-second
  outer deadlines, then build SDK/protocol/Relay in dependency order.
- [ ] Review and commit the complete contract/storage slice.

## Task 2: Codex and Claude input and history

**Files:** Both provider `session.ts`, `projector.ts`, `images.ts`, new
`message-content.ts` helpers and tests; existing native input fixtures.
**Consumes:** `AgentInputPart`, `AgentUserMessagePart`, image capability.
**Produces:** ordered multimodal send/replay using the existing session lifecycle.

- [ ] Add failing tests asserting ordered input arrays with two different images
  and three text spans, image-only input, and active-turn Codex steering.

```ts
await session.sendMessageContent(parts);
expect(nativeInput.map(part => part.type)).toEqual(['text','localImage','text','localImage','text']);
expect(projectedUser.content.map(part => part.type)).toEqual(['text','image','text','image','text']);
```

- [ ] Refactor text routing minimally so text and rich sends share busy, race,
  cancellation, and native-error behavior. Claude reads managed files into SDK
  image blocks; Codex supplies localImage paths in order.
- [ ] Project native user images with resource references and content digests;
  retain native message IDs and recover from an empty client cache.
- [ ] Refuse unsupported/read-only image sends and keep child capabilities honest.
- [ ] Run provider unit/native fixture tests with explicit deadlines; coordinate
  builds with Task 1. Record native vision verification separately.
- [ ] Review and commit provider changes.

## Task 3: Client upload, outbox, and application integration

**Files:** `agent-remote-web/src/client/remote-session-client.ts`, new
`client/image-upload.ts`, `replica/message-outbox.ts`, `replica/types.ts`,
`replica/store.ts`; Lab workbench/actions/recovery and session hooks.
**Consumes:** public content/upload contracts and response handling.
**Produces:** cancellable sequential uploader; immutable multimodal outbox;
correct application callbacks and stable recovery scope.

- [ ] Test receipt-driven offsets, repeated chunks, disconnect rejection,
  abort/session switch, native send failure, and exact-content retries.

```ts
await client.sendMessageContent(parts);
expect(replica.getState().outgoingMessages[0].content).toEqual(parts);
// A same-text native echo with a different image must not consume this entry.
expect(reconcile(differentImageEcho).outgoingMessages).toHaveLength(1);
```

- [ ] Route image results through existing request correlation and operation
  errors. Compute browser digest once per upload, resume from accepted offset,
  and yield between acknowledged chunks.
- [ ] Snapshot immutable content/digests in the outbox; canonical ordered matching
  consumes only matching new echoes. Unknown image identity remains unconfirmed.
- [ ] Wire primary and side views through their own active session clients.
  Signout clears scoped image drafts without touching unrelated storage.
- [ ] Run client/recovery tests with per-test and outer deadlines; commit after review.

## Task 4: Inline editor and durable image drafts

**Files:** new Web `react/composer-document.ts`, `react/ComposerEditor.tsx`,
`react/useImageDraft.ts`, `image-drafts.ts`; modify AgentComposer, styles,
MessageItem, OutgoingMessageItem and public exports; add ProseMirror deps.
**Consumes:** composer callbacks from shared interfaces; UserMessagePart for replay.
**Produces:** atomic image editing, upload UI, IndexedDB persistence and inline previews.

- [ ] Test pure document serialization so literal tag-looking text stays text,
  stable labels survive deletion, adjacent text merges, and image-only is nonempty.
- [ ] Implement minimal ProseMirror schema, history/keymaps, image atom NodeView,
  file-picker selection mapping, paste interception, and validated internal copy.
- [ ] Keep command handling, IME, Send hold newline, disabled/read-only behavior,
  existing height cap and text-only callback compatibility.
- [ ] Persist blobs/document in IndexedDB; guard late hydration with draft
  revisions. Missing bytes and storage errors remain visible and recoverable.
- [ ] Show upload state on fixed-size tags; Preview opens an overlay. Add image
  selection actions for Remove/Replace/Retry as appropriate.
- [ ] Render native and outgoing ordered user content using the same tag preview
  conventions and existing authorized resource requests.
- [ ] Run unit tests with deadlines, then coordinate build/browser tests. Review
  and commit this slice without touching protocol/client files owned elsewhere.

## Task 5: Whole-flow verification and documentation

**Files:** Lab e2e fixture/spec/config; Relay real-transport image-input tests;
docs/current/agent-remote/web.md, protocol docs, compatibility.json.
**Consumes:** all completed slices. **Produces:** integrated evidence and clean branch.

- [ ] Build/package before browser tests. Check all changed packages' types.
- [ ] Test real WebSocket upload/send/replay plus reconnect and cross-session
  denial; do not replace protocol acceptance with mocked callback assertions.
- [ ] Test Chromium desktop/mobile and WebKit: paste/upload at selection,
  atom selection/deletion/undo, reload, upload retry, switching, and composer
  stability. Run existing workbench/command/message-delivery regressions.
- [ ] Use a supported local native runtime and available vision endpoint to
  distinguish two test images. Do not silently substitute fixtures for a live
  model result or modify the user's existing native services.
- [ ] Update docs, run compatibility:update/check and git diff --check, perform
  final review, commit changes, and report verified/unverified boundaries.

## Verification commands

Use the repository Node 22 toolchain and `NODE_OPTIONS=--no-experimental-webstorage`.
For focused tests wrap the child process with Python `subprocess.run(...,
timeout=120, check=True)` and supply `--testTimeout=10000 --hookTimeout=15000`.
Browser runs use `--timeout=30000 --global-timeout=180000` and free configured
Relay/Web ports. Runtime builds are serialized by the coordinating agent.

## Execution decisions

- User approval of the written spec authorizes implementation in this branch;
  there is no additional execution-choice approval step.
- Task 1, Task 2, and Task 4 have disjoint ownership and explicit shared types;
  their source work can proceed independently. The coordinator implements Task 3
  and runs integration after dependency builds. Reviews precede final acceptance.
