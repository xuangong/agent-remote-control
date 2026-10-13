# Resource attachments

## Goal

Let users attach ordinary files through the composer and let Team members transfer files between independent Hosts. A Leader must be able to send a test archive to a Windows Worker and receive a report without encoding file contents in Team message text.

## User behavior

The composer menu keeps Image and adds Resource. A selected file becomes a structured resource reference displayed as `[resource #N]`, with its filename, size, upload status, removal, and retry controls. Existing Image behavior remains intact. Messages and history retain resource identity and metadata for later download. Labels are presentation, never the identity or authorization credential.

## Boundaries

The public Remote protocol carries resource upload/download operations and references. The Relay owns bounded durable file storage and verifies byte count and SHA256. The Host resolves session references into local file paths; provider adapters express them to native runtimes without executing their contents. A resource does not require native image support.

Team messages carry resource references and metadata rather than file bytes. Team membership controls publication and reads. A sender may attach its own uploads or resources it can already access; a recipient receives a way to download a verified local copy. Host-local paths are never treated as paths on another Host. Message acceptance and file download completion remain distinct.

## Limits and lifecycle

The initial limits are 50 MiB per file, eight resources and 100 MiB of resource bytes per message, and 1 GiB per configured resource store. Empty files are supported. Uploads use bounded 32 KiB chunks with offset-based resume, duplicate-chunk validation, and final digest verification. Unreferenced drafts expire after 24 hours. Referenced files remain available across supported restarts; a full store rejects new uploads rather than silently deleting referenced history.

All physical paths are generated internally. Original filenames are metadata. Downloaded content is not automatically executed. Unsupported operations, denied reads, exhausted quota, incomplete uploads, and unavailable resources produce explicit failures.

## Acceptance

- A browser-uploaded ZIP is readable by its session Agent and remains downloadable from history with the same digest.
- Separate Hosts exchange a ZIP and a returned report through Team resource references, with no file payload in Team messages.
- A file larger than the Team text quota transfers successfully; existing text quotas remain enforced.
- Retry, duplicate calls, corruption, over-limit files, foreign resource references, and restart retention are covered by observable tests.
- Existing Image and text flows continue to work. Schema fixtures and compatibility metadata match the reviewed implementation.
- Real transports and a browser exercise the new path. Platform evidence distinguishes local simulation from execution on Windows, Linux, and macOS.

## Delivery boundary

All changes stay in the resource-attachments worktree. Existing services remain running. Publishing, replacing installed Controllers, and restarting user services are separate operations from implementation and isolated verification.
