# Transfer files between Team Hosts

Team resources transfer ordinary files through Relay storage without putting file bytes into the Team communication journal. The sending and receiving Hosts can use different operating systems and working directories. A resource ID identifies bytes; a local path is meaningful only on the Host that returned it.

## Send and receive

1. On the sending member, call `upload_team_resource` with an absolute local `path` and an `operationId`. Uploads return `resourceId`, `name`, `mediaType`, `byteLength`, and `sha256` after the Relay verifies the complete file.
2. Call `send_team_message` with the usual recipient, operation identity, and text, plus `resources: [resourceId]`. Uploading alone does not send a message or grant another member access.
3. The receiving native session sees an attachment description such as `[resource #1]` with its stable ID. Call `download_team_resource` with that `resourceId`. Its result includes `localPath` and `verified: true` after checking file size and SHA256.
4. To return a report, upload the report on the receiving Host and send its resource ID back to the Leader. A member may forward a resource it received, subject to the same Leader/member communication rules.

Files supplied through the Chatbox can be forwarded by uploading the verified local path made available to the agent. Do not send another Host's local path and assume it exists on the receiving machine. Downloading does not execute a file; any execution remains a separate native operation.

By default downloads go under the Controller's Team state directory in `downloads/<identity-hash>/`. `outputDirectory` selects an absolute directory on the receiving Host. Output names are generated from the resource identity and a sanitized display name. A matching existing file is verified and reused; a different existing file is never overwritten. Failed or corrupted downloads do not publish a completed local file.

## Limits and retention

Each file may contain up to 50 MiB, including a zero-byte file. Each message may attach up to eight unique resources totaling at most 100 MiB. Relay resource storage reserves at most 1 GiB by default. Upload and download chunks contain at most 32 KiB of file data.

Unreferenced uploads, including completed uploads that have not been sent, expire after 24 hours of inactivity. Upload admission performs storage cleanup; subsequent uploads also reclaim expired, unreferenced Team metadata. A Team retains at most 1,024 resource registrations. Sending validates and pins resources before durably accepting the message. Sent resources are retained for history and forwarding; archiving does not delete them. A storage failure after pinning and before message persistence can leave retained bytes without an accepted message. Quota exhaustion is explicit; the Relay never deletes referenced history to make room.

The existing 200-message and 128 KiB Team communication limits remain in force. Resource bytes travel in separate requests and are excluded from that journal. Resource metadata remains bounded by the Team state limit. A full message journal must still be resolved independently; attachments do not create extra message slots.

## Retry, authorization, and compatibility

Reuse the upload operation ID for the same file to query the accepted offset and continue interrupted uploads. Changing the declared name, size, media type, or digest under that identity is rejected. Reuse the message operation ID for the same message and resource list; this returns the existing receipt rather than dispatching a duplicate native input. Message acceptance does not mean that a recipient downloaded, executed, or verified the file.

Resource calls authenticate the exact registered Host, Team, and member. Only the uploader and members explicitly addressed by a message containing the resource may read its bytes. Knowing an ID, seeing another member's metadata in a Team snapshot, or belonging to another Team is insufficient. Ownership and addressed-message grants survive a Relay restart with durable Team state and resource storage.

Resource support is negotiated separately from ordinary Team support. An updated Controller connected to an older Relay can still exchange text. Resource calls fail locally with an explicit unsupported message until the Relay supports and configures resource storage. No Borgee account or service is required.
