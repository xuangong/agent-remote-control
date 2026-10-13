# Resource attachments

Resource attachments carry ordinary files, including ZIP archives, scripts, and diagnostic reports. File contents travel in bounded chunks; conversation and Team messages carry references and metadata. Receiving an attachment never executes it automatically.

## Attach a file in chat

Open the composer's **…** menu and choose **Resource**, then select a local file. The composer inserts a structured `[resource #N]` reference and shows its filename, size, and upload state. Wait for the upload to complete before sending. A failed upload remains visible with Retry and Remove controls.

The connected Agent receives a verified path on its own Host. Sent messages and restored native history display the filename and a download action. Downloads verify the byte count and SHA-256 before saving. The numeric label is for display; resource identity and access checks use the stored resource ID.

**Image** remains a separate menu action for native image input. Resource input is advertised by Codex, Claude Code, and Copilot when the Host has a resource store. Providers without that capability do not expose the Resource action. A Resource reference gives the Agent a local file; it does not promise that the model understands every file format.

## Transfer files between Team members

Use the Team tools from the active Team session:

1. Call `upload_team_resource` with an absolute local `path` and an `operationId`. Keep the same operation ID when retrying the same upload.
2. Pass the returned `resourceId` in the `resources` array of `send_team_message`, alongside the normal `to`, `text`, and message `operationId`.
3. The receiving member calls `download_team_resource` with that ID. The result contains a verified `localPath` on the receiving Host. An optional absolute `outputDirectory` chooses the destination directory.
4. To return a report, the recipient uploads its local report and sends the resulting resource ID to the Leader.

An upload alone does not send a message. Message acceptance does not mean that the receiving member has downloaded the file. Team membership and the recorded sender/recipient grant control access; knowing a resource ID is insufficient. Existing files with different bytes are not overwritten.

The sending and receiving Controllers and the Relay must support Team resources. Unsupported Relays produce an explicit unsupported error. Resource payloads do not consume the Team message text budget.

## Storage and limits

| Limit | Default |
| --- | --- |
| File size | 50 MiB |
| Resources per message | 8 |
| Combined resource bytes per message | 100 MiB |
| Configured resource store | 1 GiB |
| Transfer chunk | 32 KiB |
| Unreferenced draft expiry | 24 hours |

Empty files are supported. An accepted message pins its attachments. Referenced resources are retained; a full store rejects new uploads instead of deleting files referenced by history. Uploads can resume at the last acknowledged offset while their draft remains available.

Controller session resources live in `input-resources` under its configured state directory. Team downloads use a generated path under the member's Team state directory unless `outputDirectory` is supplied. Original filenames are metadata rather than arbitrary storage paths.

Persistent Node gateway deployments store Team files beside the state file in `<stateFile>.resources`, isolated by tenant and authentication configuration. Cloudflare deployments use a separate SQLite chunk table in the Relay Durable Object. File bytes are not embedded in the bounded Team state snapshot. Access still depends on retained Team state and membership.

The standalone Lab and debugger have separate resource directories under `~/.agent-remote-control`; their server APIs accept directory overrides for isolated use. A new worktree build does not upgrade already running Controllers, Relays, or browser assets.

## Compatibility

Resource inputs extend strict public schemas in Remote protocol **1.8.0**. Upgrade Web, Relay, and Controller together for the session attachment flow. Version negotiation reports incompatible public participants explicitly. The Host uplink envelope version is independent; Team resource support is separately negotiated so an older Team Relay can continue handling text without receiving unsupported resource calls.

See [Transfer files between Team Hosts](guides/team-resources.md) for delivery receipts, retry behavior, and the distinction between resource storage and Team journal capacity.
