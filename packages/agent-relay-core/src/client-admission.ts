/**
 * What a browser session stream must pass before any message is acted on: its limits and its authorization.
 *
 * Contract. `createClientAdmission` returns `admitClientMessages(client, context, subject, expiry)`, which returns one function per stream:
 * `(raw, binary) => boolean`, true when the message may proceed. Otherwise the stream is already closed (a binary frame 1003; a message that
 * is not JSON, an upload, resource or control rate over its minute window, a credential past `expiry()`, or a non-owner resolving a locator
 * other than an input image: 1008) or the sender was answered (`reauthentication_required` when a guest's message changes
 * permissions and the sign-in is too old; the stream stays open). Limits per window of 60 seconds: 120 control messages, 600 timeline
 * requests, 2,048 image chunks of at most 48 KiB and 48 MiB, 8,192 resource messages of at most 48 KiB and 192 MiB. A window starts at the
 * first message after the previous one ended; a message from a past window counts against none of the old counters.
 */
import { decodeClientMessage, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { BrokerRequestContext, RelaySocket } from './transport.js';

export interface ClientAdmissionPorts {
  now: () => number;
  /** Whether the subject is the Host owner, who may resolve any resource locator. */
  owner(subject?: string): boolean;
}

export function createClientAdmission(ports: ClientAdmissionPorts) {
  const { now, owner } = ports;
  return function admitClientMessages(client: RelaySocket, context: BrokerRequestContext, subject: string | undefined, expiry: () => number | undefined): (raw: string, binary: boolean) => boolean {
    let messageWindow = now(); let messageCount = 0; let timelineCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0; let resourceCount = 0; let resourceBytes = 0;
    const refuse = (code: number, reason: string) => { client.close(code, reason); return false; };
    return (raw, binary) => {
      if (binary) return refuse(1003, 'Text protocol required');
      if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; timelineCount=0; imageChunkCount=0; imageChunkBytes=0; resourceCount=0; resourceBytes=0; }
      let publicMessage: { type?: string; payload?: { locator?: unknown } };
      try { publicMessage = JSON.parse(raw.toString()); } catch { return refuse(1008, 'Invalid session message'); }
      if (publicMessage?.type === 'image_upload_chunk') {
        const bytes = Buffer.byteLength(raw.toString());
        imageChunkBytes += bytes;
        if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return refuse(1008, 'Image upload rate exceeded');
      } else if (publicMessage?.type === 'resource_upload_chunk' || publicMessage?.type === 'resource_download_request'
        // A conversation's images and a previewed file's local resources resolve and read one message each.
        || publicMessage?.type === 'resource_resolve_request' || publicMessage?.type === 'resource_request') {
        const bytes = Buffer.byteLength(raw.toString()); resourceBytes += bytes;
        if (bytes > 48 * 1024 || ++resourceCount > 8192 || resourceBytes > 192 * 1024 * 1024) return refuse(1008, 'Resource transfer rate exceeded');
      } else if (publicMessage?.type === 'timeline_request') {
        // Searching and reading older history take one page per request over the session wire; they are reads, not control messages.
        if (++timelineCount > 600) return refuse(1008, 'Timeline request rate exceeded');
      } else if (++messageCount > 120) return refuse(1008, 'Control message rate exceeded');
      // The Host owner changes permissions without a recent sign-in; a guest's session runs on the owner's computer, so a guest still needs one.
      if (!owner(subject) && context.authorizeMessage?.(raw.toString()) === false) {
        const decoded = decodeClientMessage(raw.toString());
        if (decoded.status !== 'ok' || !('payload' in decoded.value) || !('requestId' in decoded.value.payload)) return refuse(1008, 'Invalid session message');
        client.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: {
          requestId: decoded.value.payload.requestId, code: 'reauthentication_required',
          message: 'Sign in again before changing session permissions. Then retry the change.', recoverable: true,
        } }));
        return false;
      }
      if (!owner(subject)) {
        try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return refuse(1008, 'Only the Host owner can resolve local files'); }
        catch { return refuse(1008, 'Invalid session message'); }
      }
      const expiresAt = expiry();
      if (expiresAt !== undefined && expiresAt <= now()) return refuse(1008, 'Credential expired');
      return true;
    };
  }
}
